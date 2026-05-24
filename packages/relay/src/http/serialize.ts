import type { Event as EventRow } from "@prisma/client";
import type { AuthorKind, SerializedEvent } from "../types.js";

export function serializeEvent(e: EventRow): SerializedEvent {
  return {
    id: String(e.id),
    surface_id: e.surfaceId,
    author: { kind: e.authorKind as AuthorKind, id: e.authorId },
    ts: e.ts.toISOString(),
    type: e.type,
    data: e.data,
    causation_id: e.causationId,
    idempotency_key: e.idempotencyKey,
  };
}
