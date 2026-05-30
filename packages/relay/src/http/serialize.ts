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
    // #268 — passthrough of the stamped template version. Both nullable for
    // pre-#268 events (the migration backfilled most from the surface's
    // current pin; any that slipped through stay null).
    template_version_id: e.templateVersionId,
    template_version: e.templateVersionNum,
  };
}
