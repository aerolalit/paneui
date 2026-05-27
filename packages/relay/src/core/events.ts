import { Prisma } from "@prisma/client";
import type { TemplateVersion, PrismaClient, Surface } from "@prisma/client";
import type { Config } from "../config.js";
import { decryptSecret } from "../crypto.js";
import { publish } from "../http/broadcast.js";
import { errors } from "../http/errors.js";
import { serializeEvent } from "../http/serialize.js";
import { fire, shouldFire } from "../http/webhook.js";
import { log } from "../log.js";
import { recordEventWritten } from "../telemetry/metrics.js";
import type { Author, EventSchema, SerializedEvent } from "../types.js";
import { validateEvent } from "./validation.js";
import {
  assertBlobsAccessibleByAgent,
  collectBlobRefs,
} from "../attachments/ref-access.js";

// A surface row with its pinned template version eagerly loaded. The event
// vocabulary (`eventSchema`) and the per-version event-schema number live on
// `templateVersion` since the reusable-templates change — so every caller of
// writeEvent must load the surface with `include: { templateVersion: true }`.
export type SurfaceWithArtifactVersion = Surface & {
  templateVersion: TemplateVersion;
};

export interface WriteEventInput {
  type: string;
  data: unknown;
  causationId?: string | null;
  idempotencyKey?: string | null;
}

export interface WriteEventResult {
  event: SerializedEvent;
  deduped: boolean;
}

// Injected dependencies for writeEvent — the Prisma client and config are
// passed in rather than imported as module singletons.
export interface WriteEventDeps {
  prisma: PrismaClient;
  config: Config;
}

// Append a system-authored event (authorKind/authorId = "system") to a surface
// and broadcast it to connected peers. Used for system.schema.updated,
// system.template.updated, system.surface.expired and system.participant.joined.
//
// `prisma` is injected by the caller — there is no module-singleton client.
//
// `decorate` lets a caller transform only the in-memory broadcast copy (the
// persisted row is untouched) — the WS handler uses it to ride a live agent
// count on participant.joined without persisting that count. It may be async:
// the live agent count is read from the presence registry, which is
// Redis-backed (and therefore async) in multi-replica deployments.
//
// Returns `null` when the surface no longer exists: a surface can be deleted
// or expire-and-be-swept while a WS connection is still mid-handshake, so the
// `participant.joined` write can race the parent row away. That surfaces as a
// Prisma P2003 foreign-key violation, which we swallow — the system event has
// no surface to belong to, and crashing handleConnection over it is wrong.
export async function appendSystemEvent(
  prisma: PrismaClient,
  surfaceId: string,
  type: string,
  data: object,
  decorate?: (e: SerializedEvent) => SerializedEvent | Promise<SerializedEvent>,
): Promise<SerializedEvent | null> {
  let event;
  try {
    event = await prisma.event.create({
      data: {
        surfaceId,
        authorKind: "system",
        authorId: "system",
        type,
        data: data as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2003"
    ) {
      log.warn("appendSystemEvent skipped: surface no longer exists", {
        surfaceId,
        type,
      });
      return null;
    }
    throw err;
  }
  recordEventWritten("system");
  const serialized = serializeEvent(event);
  publish(surfaceId, decorate ? await decorate(serialized) : serialized);
  return serialized;
}

// Single source of truth for "an authenticated participant or agent emits an
// event on a surface." Used by both POST /v1/surfaces/:id/events and the WS
// frame handler so the validation/dedupe/publish/webhook pipeline stays in lock
// step across transports.
export async function writeEvent(
  deps: WriteEventDeps,
  surface: SurfaceWithArtifactVersion,
  author: Author,
  input: WriteEventInput,
): Promise<WriteEventResult> {
  const { prisma, config } = deps;
  if (surface.status !== "open" || surface.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  if (
    Buffer.byteLength(JSON.stringify(input.data ?? null), "utf8") >
    config.MAX_EVENT_DATA_BYTES
  ) {
    throw errors.payloadTooLarge();
  }

  // Per-surface event cap: bound unbounded event accumulation on a single
  // surface so an abusive client cannot exhaust storage. System events
  // (participant join/leave, schema/template updates) count toward the cap.
  // This is a count-then-create check, so it is a SOFT cap — concurrent
  // writers can race past it and overshoot by roughly the number of inflight
  // writes. That is acceptable: the cap exists to bound abuse to ~N, not to
  // enforce an exact row count, and the limit is deliberately generous.
  if (config.MAX_EVENTS_PER_SESSION > 0) {
    const count = await prisma.event.count({
      where: { surfaceId: surface.id },
    });
    if (count >= config.MAX_EVENTS_PER_SESSION) {
      throw errors.tooManyRequests(
        `surface event cap reached (max ${config.MAX_EVENTS_PER_SESSION}); create a new surface to continue`,
      );
    }
  }

  // The pinned version's eventSchema is nullable since view-only templates —
  // null means "no event vocabulary", and validateEvent's guard rejects every
  // page/agent emit against such a surface. System events never reach here
  // (appendSystemEvent writes directly), so they are unaffected.
  const eventSchema = surface.templateVersion
    .eventSchema as unknown as EventSchema | null;
  validateEvent({
    surfaceId: surface.id,
    schemaVersion: surface.templateVersion.version,
    schema: eventSchema,
    type: input.type,
    data: input.data,
    authorKind: author.kind,
  });

  // Follow-up B of #156 — attachment-ref DB access check. AFTER Ajv shape
  // validation, walk the per-type payload schema for sites marked
  // `format: pane-attachment-id` and batch-verify the surface's owning agent
  // can actually access each referenced attachment. The surface's `agentId`
  // is the authz anchor here, not `author.id`: a participant emitting
  // via the WS path can legitimately reference a attachment the *agent*
  // owns, but neither identity should be able to bake another agent's
  // attachment_id into the payload. See attachments/ref-access.ts.
  if (eventSchema) {
    const entry = eventSchema.events[input.type];
    if (entry) {
      const refs = collectBlobRefs(entry.payload, input.data);
      if (refs.length > 0) {
        await assertBlobsAccessibleByAgent(prisma, surface.agentId, refs);
      }
    }
  }

  // Insert-or-return-existing under the (surfaceId, authorId, idempotencyKey) unique
  // index. Doing a separate findUnique + create races: two concurrent retries can
  // both see null and both attempt insert, with the loser getting P2002. We catch
  // that here and re-read instead of bubbling a 500.
  const idemKey = input.idempotencyKey ?? null;
  let row;
  let deduped = false;
  try {
    row = await prisma.event.create({
      data: {
        surfaceId: surface.id,
        authorKind: author.kind,
        authorId: author.id,
        type: input.type,
        data: (input.data ?? null) as Prisma.InputJsonValue,
        causationId: input.causationId ?? null,
        idempotencyKey: idemKey,
      },
    });
  } catch (err) {
    if (
      idemKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await prisma.event.findUnique({
        where: {
          surfaceId_authorId_idempotencyKey: {
            surfaceId: surface.id,
            authorId: author.id,
            idempotencyKey: idemKey,
          },
        },
      });
      if (!existing) throw err;
      row = existing;
      deduped = true;
    } else {
      throw err;
    }
  }

  const serialized = serializeEvent(row);
  if (!deduped) {
    // Count only freshly-persisted events — a deduped idempotency replay does
    // not write a new row, so it must not bump the counter.
    recordEventWritten(author.kind);
    publish(surface.id, serialized);
    fireWebhook(surface, input.type, serialized);
  }
  return { event: serialized, deduped };
}

function fireWebhook(
  surface: Surface,
  type: string,
  event: SerializedEvent,
): void {
  if (!surface.callbackUrl || !surface.callbackSecretEnc) return;
  if (!shouldFire(type, surface.callbackFilter as string[] | null)) return;

  let secret: string;
  try {
    secret = decryptSecret(surface.callbackSecretEnc);
  } catch (err) {
    log.error("webhook secret decrypt failed", {
      surfaceId: surface.id,
      error: String(err),
    });
    return;
  }
  fire(
    {
      url: surface.callbackUrl,
      secret,
    },
    surface.id,
    event,
  ).catch((err: unknown) =>
    log.warn("webhook delivery failed", {
      surfaceId: surface.id,
      eventId: event.id,
      error: String(err),
    }),
  );
}
