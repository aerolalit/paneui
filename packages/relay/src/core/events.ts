import { Prisma } from "@prisma/client";
import type { TemplateVersion, PrismaClient, Pane } from "@prisma/client";
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

// A pane row with its pinned template version eagerly loaded. The event
// vocabulary (`eventSchema`) and the per-version event-schema number live on
// `templateVersion` since the reusable-templates change — so every caller of
// writeEvent must load the pane with `include: { templateVersion: true }`.
export type PaneWithTemplateVersion = Pane & {
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

// Append a system-authored event (authorKind/authorId = "system") to a pane
// and broadcast it to connected peers. Used for system.schema.updated,
// system.template.updated, system.pane.expired and system.participant.joined.
//
// `prisma` is injected by the caller — there is no module-singleton client.
//
// `decorate` lets a caller transform only the in-memory broadcast copy (the
// persisted row is untouched) — the WS handler uses it to ride a live agent
// count on participant.joined without persisting that count. It may be async:
// the live agent count is read from the presence registry, which is
// Redis-backed (and therefore async) in multi-replica deployments.
//
// Returns `null` when the pane no longer exists: a pane can be deleted
// or expire-and-be-swept while a WS connection is still mid-handshake, so the
// `participant.joined` write can race the parent row away. That panes as a
// Prisma P2003 foreign-key violation, which we swallow — the system event has
// no pane to belong to, and crashing handleConnection over it is wrong.
export async function appendSystemEvent(
  prisma: PrismaClient,
  paneId: string,
  type: string,
  data: object,
  decorate?: (e: SerializedEvent) => SerializedEvent | Promise<SerializedEvent>,
): Promise<SerializedEvent | null> {
  // Look up the pane's currently-pinned templateVersion so we can stamp
  // (templateVersionId, templateVersionNum) on the event row (#268). System
  // events are infrequent — one tiny SELECT per join/leave/expire is fine.
  // A missing pane here means the row was swept between the caller's
  // entry and our insert; fall through with null stamps so the foreign-key
  // failure in `create` produces the existing P2003 recovery path below.
  const pane = await prisma.pane.findUnique({
    where: { id: paneId },
    select: {
      templateVersionId: true,
      templateVersion: { select: { version: true } },
    },
  });
  let event;
  try {
    event = await prisma.event.create({
      data: {
        paneId,
        authorKind: "system",
        authorId: "system",
        type,
        data: data as Prisma.InputJsonValue,
        templateVersionId: pane?.templateVersionId ?? null,
        templateVersionNum: pane?.templateVersion?.version ?? null,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2003"
    ) {
      log.warn("appendSystemEvent skipped: pane no longer exists", {
        paneId,
        type,
      });
      return null;
    }
    throw err;
  }
  recordEventWritten("system");
  const serialized = serializeEvent(event);
  publish(paneId, decorate ? await decorate(serialized) : serialized);
  return serialized;
}

// Single source of truth for "an authenticated participant or agent emits an
// event on a pane." Used by both POST /v1/panes/:id/events and the WS
// frame handler so the validation/dedupe/publish/webhook pipeline stays in lock
// step across transports.
export async function writeEvent(
  deps: WriteEventDeps,
  pane: PaneWithTemplateVersion,
  author: Author,
  input: WriteEventInput,
): Promise<WriteEventResult> {
  const { prisma, config } = deps;
  if (pane.status !== "open" || pane.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  if (
    Buffer.byteLength(JSON.stringify(input.data ?? null), "utf8") >
    config.MAX_EVENT_DATA_BYTES
  ) {
    throw errors.payloadTooLarge();
  }

  // Per-pane event cap: bound unbounded event accumulation on a single
  // pane so an abusive client cannot exhaust storage. System events
  // (participant join/leave, schema/template updates) count toward the cap.
  // This is a count-then-create check, so it is a SOFT cap — concurrent
  // writers can race past it and overshoot by roughly the number of inflight
  // writes. That is acceptable: the cap exists to bound abuse to ~N, not to
  // enforce an exact row count, and the limit is deliberately generous.
  if (config.MAX_EVENTS_PER_PANE > 0) {
    const count = await prisma.event.count({
      where: { paneId: pane.id },
    });
    if (count >= config.MAX_EVENTS_PER_PANE) {
      throw errors.tooManyRequests(
        `pane event cap reached (max ${config.MAX_EVENTS_PER_PANE}); create a new pane to continue`,
      );
    }
  }

  // The pinned version's eventSchema is nullable since view-only templates —
  // null means "no event vocabulary", and validateEvent's guard rejects every
  // page/agent emit against such a pane. System events never reach here
  // (appendSystemEvent writes directly), so they are unaffected.
  const eventSchema = pane.templateVersion
    .eventSchema as unknown as EventSchema | null;
  validateEvent({
    paneId: pane.id,
    schemaVersion: pane.templateVersion.version,
    schema: eventSchema,
    type: input.type,
    data: input.data,
    authorKind: author.kind,
  });

  // Follow-up B of #156 — attachment-ref DB access check. AFTER Ajv shape
  // validation, walk the per-type payload schema for sites marked
  // `format: pane-attachment-id` and batch-verify the pane's owning agent
  // can actually access each referenced attachment. The pane's `agentId`
  // is the authz anchor here, not `author.id`: a participant emitting
  // via the WS path can legitimately reference a attachment the *agent*
  // owns, but neither identity should be able to bake another agent's
  // attachment_id into the payload. See attachments/ref-access.ts.
  if (eventSchema) {
    const entry = eventSchema.events[input.type];
    if (entry) {
      const refs = collectBlobRefs(entry.payload, input.data);
      if (refs.length > 0) {
        await assertBlobsAccessibleByAgent(prisma, pane.agentId, refs);
      }
    }
  }

  // Insert-or-return-existing under the (paneId, authorId, idempotencyKey) unique
  // index. Doing a separate findUnique + create races: two concurrent retries can
  // both see null and both attempt insert, with the loser getting P2002. We catch
  // that here and re-read instead of bubbling a 500.
  const idemKey = input.idempotencyKey ?? null;
  let row;
  let deduped = false;
  try {
    row = await prisma.event.create({
      data: {
        paneId: pane.id,
        authorKind: author.kind,
        authorId: author.id,
        type: input.type,
        data: (input.data ?? null) as Prisma.InputJsonValue,
        causationId: input.causationId ?? null,
        idempotencyKey: idemKey,
        // #268 — stamp the pane's current pin so downstream readers can
        // tell which template version's schema this event was validated
        // against. pane.templateVersion is eager-loaded by every
        // writeEvent caller (see PaneWithTemplateVersion above).
        templateVersionId: pane.templateVersionId,
        templateVersionNum: pane.templateVersion.version,
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
          paneId_authorId_idempotencyKey: {
            paneId: pane.id,
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
    publish(pane.id, serialized);
    fireWebhook(pane, input.type, serialized);
  }
  return { event: serialized, deduped };
}

function fireWebhook(pane: Pane, type: string, event: SerializedEvent): void {
  if (!pane.callbackUrl || !pane.callbackSecretEnc) return;
  if (!shouldFire(type, pane.callbackFilter as string[] | null)) return;

  let secret: string;
  try {
    secret = decryptSecret(pane.callbackSecretEnc);
  } catch (err) {
    log.error("webhook secret decrypt failed", {
      paneId: pane.id,
      error: String(err),
    });
    return;
  }
  fire(
    {
      url: pane.callbackUrl,
      secret,
    },
    pane.id,
    event,
  ).catch((err: unknown) =>
    log.warn("webhook delivery failed", {
      paneId: pane.id,
      eventId: event.id,
      error: String(err),
    }),
  );
}
