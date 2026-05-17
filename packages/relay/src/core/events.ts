import { Prisma } from "@prisma/client";
import type { Session } from "@prisma/client";
import config from "../config.js";
import prisma from "../db.js";
import { decryptSecret } from "../crypto.js";
import { publish } from "../http/broadcast.js";
import { errors } from "../http/errors.js";
import { serializeEvent } from "../http/serialize.js";
import { fire, shouldFire } from "../http/webhook.js";
import { log } from "../log.js";
import type { Author, EventSchema, SerializedEvent } from "../types.js";
import { validateEvent } from "./validation.js";

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

// Single source of truth for "an authenticated participant or agent emits an
// event on a session." Used by both POST /v1/sessions/:id/events and the WS
// frame handler so the validation/dedupe/publish/webhook pipeline stays in lock
// step across transports.
export async function writeEvent(
  session: Session,
  author: Author,
  input: WriteEventInput,
): Promise<WriteEventResult> {
  if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  if (
    Buffer.byteLength(JSON.stringify(input.data ?? null), "utf8") >
    config.MAX_EVENT_DATA_BYTES
  ) {
    throw errors.payloadTooLarge();
  }

  validateEvent({
    sessionId: session.id,
    schemaVersion: session.schemaVersion,
    schema: session.eventSchema as unknown as EventSchema,
    type: input.type,
    data: input.data,
    authorKind: author.kind,
  });

  // Insert-or-return-existing under the (sessionId, authorId, idempotencyKey) unique
  // index. Doing a separate findUnique + create races: two concurrent retries can
  // both see null and both attempt insert, with the loser getting P2002. We catch
  // that here and re-read instead of bubbling a 500.
  const idemKey = input.idempotencyKey ?? null;
  let row;
  let deduped = false;
  try {
    row = await prisma.event.create({
      data: {
        sessionId: session.id,
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
          sessionId_authorId_idempotencyKey: {
            sessionId: session.id,
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
    publish(session.id, serialized);
    fireWebhook(session, input.type, serialized);
  }
  return { event: serialized, deduped };
}

function fireWebhook(
  session: Session,
  type: string,
  event: SerializedEvent,
): void {
  if (!session.callbackUrl || !session.callbackSecretEnc) return;
  if (!shouldFire(type, session.callbackFilter as string[] | null)) return;

  let secret: string;
  try {
    secret = decryptSecret(session.callbackSecretEnc);
  } catch (err) {
    log.error("webhook secret decrypt failed", {
      sessionId: session.id,
      err: String(err),
    });
    return;
  }
  fire(
    {
      url: session.callbackUrl,
      secret,
      filter: (session.callbackFilter as string[]) ?? [],
    },
    session.id,
    event,
  ).catch((err: unknown) =>
    log.warn("webhook delivery failed", {
      sessionId: session.id,
      eventId: event.id,
      err: String(err),
    }),
  );
}
