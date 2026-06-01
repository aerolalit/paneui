// #296 — unit tests for the in-shell RecordStore. Pure module, no DOM,
// safe to run under vitest's default environment.

import { describe, it, expect, beforeEach } from "vitest";
import {
  RecordStore,
  type RecordDeleteMessage,
  type RecordUpsertMessage,
  type SerializedRecord,
} from "./record-store.js";

function row(
  key: string,
  seq: number,
  data: unknown = { body: key },
): SerializedRecord {
  return {
    id: `rec_${key}`,
    collection: "comments",
    key,
    data,
    version: 1,
    seq,
    author: { kind: "human", id: "h_alice" },
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    deleted_at: null,
  };
}

function upsert(r: SerializedRecord): RecordUpsertMessage {
  return { kind: "record.upsert", collection: r.collection, record: r };
}

function del(key: string, seq: number): RecordDeleteMessage {
  return {
    kind: "record.delete",
    collection: "comments",
    record: {
      id: `rec_${key}`,
      key,
      seq,
      deleted_at: "2026-06-01T00:00:00.000Z",
    },
  };
}

describe("RecordStore", () => {
  let store: RecordStore;
  beforeEach(() => {
    store = new RecordStore();
  });

  it("applyUpsert stores a fresh row and returns the delta", () => {
    const delta = store.applyUpsert(upsert(row("a", 1)));
    expect(delta).toEqual({
      kind: "upsert",
      collection: "comments",
      record: expect.objectContaining({ key: "a" }),
    });
    expect(store.snapshot("comments").map((r) => r.key)).toEqual(["a"]);
  });

  it("applyUpsert with a higher seq replaces the existing row", () => {
    store.applyUpsert(upsert(row("a", 1, { body: "v1" })));
    const delta = store.applyUpsert(upsert(row("a", 2, { body: "v2" })));
    expect(delta).not.toBeNull();
    expect(store.snapshot("comments")).toHaveLength(1);
    expect(store.snapshot("comments")[0]!.data).toEqual({ body: "v2" });
  });

  it("applyUpsert is idempotent — same seq returns null and doesn't mutate", () => {
    store.applyUpsert(upsert(row("a", 5)));
    const delta = store.applyUpsert(upsert(row("a", 5, { body: "ignored" })));
    expect(delta).toBeNull();
    // Original data preserved.
    expect(store.snapshot("comments")[0]!.data).toEqual({ body: "a" });
  });

  it("applyUpsert with a lower seq is dropped as stale", () => {
    store.applyUpsert(upsert(row("a", 10)));
    const delta = store.applyUpsert(upsert(row("a", 3)));
    expect(delta).toBeNull();
  });

  it("applyDelete removes the row from the snapshot", () => {
    store.applyUpsert(upsert(row("a", 1)));
    store.applyUpsert(upsert(row("b", 2)));
    const delta = store.applyDelete(del("a", 3));
    expect(delta).not.toBeNull();
    expect(store.snapshot("comments").map((r) => r.key)).toEqual(["b"]);
  });

  it("applyDelete advances the per-collection cursor even when the row never existed", () => {
    // Reconnect case: client missed the upsert that created the row, but
    // received the delete. The cursor still needs to advance.
    const delta = store.applyDelete(del("phantom", 5));
    expect(delta).not.toBeNull();
    expect(store.reconnectCursorQuery()).toBe("since_record_seq.comments=5");
  });

  it("applyDelete is stale-safe (seq <= last seen returns null)", () => {
    store.applyUpsert(upsert(row("a", 10)));
    const delta = store.applyDelete(del("a", 5));
    expect(delta).toBeNull();
    expect(store.snapshot("comments")).toHaveLength(1); // unchanged
  });

  it("reconnectCursorQuery encodes the lastSeq map as URL query params", () => {
    store.applyUpsert(upsert(row("a", 3)));
    store.applyUpsert(upsert({ ...row("p1", 7), collection: "posts" }));
    const qs = store.reconnectCursorQuery();
    // Order isn't guaranteed (Map iteration is insertion order, but the
    // assertion shouldn't depend on it).
    const parts = qs.split("&").sort();
    expect(parts).toEqual([
      "since_record_seq.comments=3",
      "since_record_seq.posts=7",
    ]);
  });

  it("reconnectCursorQuery returns empty string when no records seen", () => {
    expect(store.reconnectCursorQuery()).toBe("");
  });

  it("snapshot of an unseen collection returns an empty array (not an error)", () => {
    expect(store.snapshot("never_seen")).toEqual([]);
  });

  it("multiple collections stay isolated", () => {
    store.applyUpsert(upsert(row("a", 1)));
    store.applyUpsert(upsert({ ...row("p1", 1), collection: "posts" }));
    store.applyUpsert(upsert(row("b", 2)));
    expect(store.snapshot("comments").map((r) => r.key)).toEqual(["a", "b"]);
    expect(store.snapshot("posts").map((r) => r.key)).toEqual(["p1"]);
  });
});
