// In-shell record store (#296).
//
// The bridge shell owns one of these per surface. Records arrive as
// `record.upsert` / `record.delete` messages on the WS channel, get folded
// into this store, and a delta is pushed into the iframe via postMessage
// (the iframe-routing piece lands in #298 — this PR's scope is the store
// itself + the merge/delete behaviour).
//
// Keyed by (collection, recordKey). Per-collection seq tracking drives the
// reconnect cursors (`?since_record_seq.<name>=<last>`) so a transient WS
// disconnect doesn't double-deliver or miss rows.
//
// Pure module — no DOM, no WebSocket, no postMessage. Unit-testable in
// isolation.

// Wire-shape types inlined here because the bridge/client tsconfig
// (tsconfig.client.json) restricts rootDir to this directory — it cannot
// import from ../../ws/messages.js. The canonical declarations live in
// ws/messages.ts (#294); these are structurally identical and must stay in
// sync. A drift would surface in the record-store.test.ts assertions.
export interface SerializedRecord {
  id: string;
  collection: string;
  key: string;
  data: unknown;
  version: number;
  seq: number;
  author: { kind: "agent" | "human" | "system"; id: string };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export interface DeletedRecordRef {
  id: string;
  key: string;
  seq: number;
  deleted_at: string;
}
export interface RecordUpsertMessage {
  kind: "record.upsert";
  collection: string;
  record: SerializedRecord;
}
export interface RecordDeleteMessage {
  kind: "record.delete";
  collection: string;
  record: DeletedRecordRef;
}

export type RecordDeltaForIframe =
  | { kind: "upsert"; collection: string; record: SerializedRecord }
  | { kind: "delete"; collection: string; record: DeletedRecordRef };

export class RecordStore {
  // Outer map: collection name → inner map. Inner map: recordKey → row.
  // A delete removes the inner-map entry; the row itself is gone from the
  // store (the tombstone is only relevant on the wire, for the moment of
  // observation — the store reflects current live state).
  private readonly byCollection = new Map<
    string,
    Map<string, SerializedRecord>
  >();
  // Last seen seq per collection, used for reconnect-resume cursors.
  // Includes tombstone seqs — the cursor advances on every observed delta.
  private readonly lastSeq = new Map<string, number>();

  /**
   * Apply an upsert. Replaces any existing row at (collection, key). Returns
   * the delta to forward to the iframe — null when the message is stale
   * (seq <= last observed for that collection), which can happen if the
   * shell receives a duplicate via a Redis loopback race.
   */
  applyUpsert(msg: RecordUpsertMessage): RecordDeltaForIframe | null {
    const last = this.lastSeq.get(msg.collection) ?? 0;
    if (msg.record.seq <= last) return null;
    let inner = this.byCollection.get(msg.collection);
    if (!inner) {
      inner = new Map();
      this.byCollection.set(msg.collection, inner);
    }
    inner.set(msg.record.key, msg.record);
    this.lastSeq.set(msg.collection, msg.record.seq);
    return { kind: "upsert", collection: msg.collection, record: msg.record };
  }

  /**
   * Apply a delete. Removes the entry from the store. Returns the delta to
   * forward, or null if stale.
   */
  applyDelete(msg: RecordDeleteMessage): RecordDeltaForIframe | null {
    const last = this.lastSeq.get(msg.collection) ?? 0;
    if (msg.record.seq <= last) return null;
    const inner = this.byCollection.get(msg.collection);
    if (inner) inner.delete(msg.record.key);
    this.lastSeq.set(msg.collection, msg.record.seq);
    return { kind: "delete", collection: msg.collection, record: msg.record };
  }

  /**
   * Snapshot the live state of a collection — an array of rows in insertion
   * order. Empty array for an unseen collection. The runtime API (#298)
   * reads from here to seed `pane.records.snapshot(name)`.
   */
  snapshot(collection: string): SerializedRecord[] {
    const inner = this.byCollection.get(collection);
    if (!inner) return [];
    return Array.from(inner.values());
  }

  /**
   * Build the reconnect-cursor query-string fragment from the per-collection
   * `lastSeq` map. The shell appends this to the WS URL on reconnect so the
   * relay's #295 replay path skips already-observed rows. Returns an empty
   * string if no record traffic has been seen.
   */
  reconnectCursorQuery(): string {
    if (this.lastSeq.size === 0) return "";
    const parts: string[] = [];
    for (const [name, seq] of this.lastSeq.entries()) {
      parts.push(`since_record_seq.${encodeURIComponent(name)}=${seq}`);
    }
    return parts.join("&");
  }

  /**
   * Names of every collection that has had at least one observed delta on
   * this store. Used by #298 to enumerate collections for the initial
   * snapshot push into the iframe.
   */
  observedCollections(): string[] {
    return Array.from(this.lastSeq.keys());
  }

  /** Test-only — drop all state. Not part of the public API. */
  __resetForTests(): void {
    this.byCollection.clear();
    this.lastSeq.clear();
  }
}
