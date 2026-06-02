// messages.ts — formal WS wire-message types for the relay (#294).
//
// Every message that flows from the relay to a connected WebSocket client is
// one of the shapes below. The handler (ws/handler.ts) reads from the
// broadcast bus, stringifies, and forwards; subscribers that need to
// distinguish use the predicates in http/broadcast.ts.
//
// Discriminator rule: events have NO top-level `kind` field; everything else
// does. The discrimination is intentionally one-sided to preserve the
// pre-records event-wire shape unchanged (no schema break for existing
// clients).
//
// This module is the SINGLE source of truth for record-wire shapes. core/records.ts
// re-exports the discriminated union so writer callers can construct messages
// without importing from the ws/ subtree. http/broadcast.ts imports
// `WireMessage` for the publish/subscribe typing.

import type { AuthorKind, SerializedEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Record-collection wire shapes (#287)
// ---------------------------------------------------------------------------

/**
 * One record on the wire. Same shape the route layer returns from
 * GET/POST/PATCH responses — kept identical so a client can apply both
 * REST responses and live WS deltas through one code path.
 */
export interface SerializedRecord {
  id: string;
  collection: string;
  key: string;
  data: unknown;
  version: number;
  seq: number;
  author: { kind: AuthorKind; id: string };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Smaller wire shape for a tombstone — clients only need enough to evict
 * the row from local state (id + key for indexing, seq for cursor advance,
 * deleted_at for observability).
 */
export interface DeletedRecordRef {
  id: string;
  key: string;
  seq: number;
  deleted_at: string;
}

/** Live record-state change: fresh write OR mutation. */
export interface RecordUpsertMessage {
  kind: "record.upsert";
  collection: string;
  record: SerializedRecord;
}

/** Live tombstone — soft delete, kept until tombstone TTL (#293). */
export interface RecordDeleteMessage {
  kind: "record.delete";
  collection: string;
  record: DeletedRecordRef;
}

/**
 * Replay sentinel — emitted once per subscribed collection after the
 * replay set has been drained, mirroring `system.replay.complete` for
 * events. Lets clients know it's safe to switch from "syncing initial
 * state" to "applying live deltas." Consumed by #295 (handleConnection).
 */
export interface RecordReplayCompleteMessage {
  kind: "record.replay.complete";
  collection: string;
  seq: number;
}

export type RecordDeltaMessage =
  | RecordUpsertMessage
  | RecordDeleteMessage
  | RecordReplayCompleteMessage;

// ---------------------------------------------------------------------------
// Template-level record wire shapes
// ---------------------------------------------------------------------------

/**
 * Live template-level record state change. Broadcast to every pane derived
 * from the template (regardless of pinned version) — clients filter by the
 * collection name they subscribed to. Wire shape mirrors RecordUpsertMessage
 * but uses a distinct `kind` so iframe-side `pane.records.*` and
 * `pane.template.records.*` namespaces don't collapse.
 */
export interface TemplateRecordUpsertMessage {
  kind: "template-record.upsert";
  collection: string;
  record: SerializedRecord;
}

export interface TemplateRecordDeleteMessage {
  kind: "template-record.delete";
  collection: string;
  record: DeletedRecordRef;
}

export interface TemplateRecordReplayCompleteMessage {
  kind: "template-record.replay.complete";
  collection: string;
  seq: number;
}

export type TemplateRecordDeltaMessage =
  | TemplateRecordUpsertMessage
  | TemplateRecordDeleteMessage
  | TemplateRecordReplayCompleteMessage;

// ---------------------------------------------------------------------------
// System-level sentinels (existing — moved here for one-stop wire-shape ref)
// ---------------------------------------------------------------------------

/**
 * Emitted once per connection after the full event-history replay has
 * finished. Predates records; preserved unchanged. Clients use it as the
 * boundary between "applying replayed history" and "applying live events."
 */
export interface SystemReplayCompleteMessage {
  kind: "system.replay.complete";
}

// ---------------------------------------------------------------------------
// The discriminated wire union
// ---------------------------------------------------------------------------

/**
 * Any message that can flow over the per-pane WS channel. Discriminated
 * by the top-level `kind` field — events have NO `kind`, every other
 * message does. `isEvent` / `isRecordDelta` / `isSystemSentinel` predicates
 * are exported from http/broadcast.ts.
 *
 * Adding a new wire-message kind:
 *   1. Add the interface here.
 *   2. Add it to the WireMessage union.
 *   3. Add a predicate to http/broadcast.ts if subscribers need to filter.
 *   4. Update SKILL.md so template authors know about it.
 */
export type WireMessage =
  | SerializedEvent
  | RecordDeltaMessage
  | TemplateRecordDeltaMessage
  | SystemReplayCompleteMessage;

// ---------------------------------------------------------------------------
// Constructor helpers — small enough to inline, but exported so the
// downstream writers don't accidentally drift on the message shape.
// ---------------------------------------------------------------------------

export function recordUpsert(
  collection: string,
  record: SerializedRecord,
): RecordUpsertMessage {
  return { kind: "record.upsert", collection, record };
}

export function recordDelete(
  collection: string,
  record: DeletedRecordRef,
): RecordDeleteMessage {
  return { kind: "record.delete", collection, record };
}

export function recordReplayComplete(
  collection: string,
  seq: number,
): RecordReplayCompleteMessage {
  return { kind: "record.replay.complete", collection, seq };
}

export function templateRecordUpsert(
  collection: string,
  record: SerializedRecord,
): TemplateRecordUpsertMessage {
  return { kind: "template-record.upsert", collection, record };
}

export function templateRecordDelete(
  collection: string,
  record: DeletedRecordRef,
): TemplateRecordDeleteMessage {
  return { kind: "template-record.delete", collection, record };
}

export function templateRecordReplayComplete(
  collection: string,
  seq: number,
): TemplateRecordReplayCompleteMessage {
  return { kind: "template-record.replay.complete", collection, seq };
}

export const SYSTEM_REPLAY_COMPLETE: SystemReplayCompleteMessage = {
  kind: "system.replay.complete",
};
