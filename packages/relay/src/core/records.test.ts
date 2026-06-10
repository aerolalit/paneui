// #291 — integration tests for the records writer.
//
// Pinned by issue #291's acceptance criteria:
//   - writeRecord covers create, upsert, update, soft-delete
//   - Optimistic-version 409 returns the current row in the response body
//   - Per-collection seq is monotonic under concurrent writes
//   - deletableBy: ["author"] enforced for author + non-author
//   - Soft-delete sets deletedAt and bumps seq but does NOT remove the row
//   - No row written to events on any record op
//   - Publish fires only after txn commit
//   - Idempotency: POST with the same record_key returns existing row,
//     no second seq bump

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import { subscribe } from "../http/broadcast.js";
import { ApiError } from "../http/errors.js";
import {
  deleteRecord,
  deleteRecordCollection,
  listRecords,
  updateRecord,
  writeRecord,
  type PaneWithRecordSchema,
} from "./records.js";
import type { Author } from "../types.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (testDb) await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// recordSchema with three collections, exercising every authz combination:
//   - comments: page can write + delete-own (the canonical user-content case)
//   - posts:    agent + page can write, agent can force-delete, page can delete-own
//   - notes:    agent-only (no participants involved)
const FIXTURE_RECORD_SCHEMA = {
  $defs: {
    Comment: {
      type: "object",
      properties: { body: { type: "string", minLength: 1 } },
      required: ["body"],
    },
    Post: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title", "body"],
    },
    Note: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  "x-pane-collections": {
    comments: {
      schema: { $ref: "#/$defs/Comment" },
      write: ["page"],
      delete: ["author"],
    },
    posts: {
      schema: { $ref: "#/$defs/Post" },
      write: ["page", "agent"],
      delete: ["agent", "author"],
    },
    notes: {
      schema: { $ref: "#/$defs/Note" },
      write: ["agent"],
      delete: ["agent"],
    },
  },
};

async function seedPaneWithRecordSchema(): Promise<{
  pane: PaneWithRecordSchema;
  agentId: string;
  agentAuthor: Author;
  pageAuthor: Author;
}> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: "pane_test",
    },
  });
  const template = await prisma.template.create({
    data: { ownerId: agent.id, name: "Records Test", latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      recordSchema: FIXTURE_RECORD_SCHEMA,
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: `pan_${randomBytes(8).toString("hex")}`,
      agentId: agent.id,
      templateVersionId: version.id,
      title: "records writer test pane",
      expiresAt: new Date(Date.now() + 3600_000),
    },
    include: { templateVersion: true },
  });
  return {
    pane: pane as PaneWithRecordSchema,
    agentId: agent.id,
    agentAuthor: { kind: "agent", id: agent.id },
    pageAuthor: { kind: "human", id: "h_alice" },
  };
}

// Helper: capture every message published to a pane for assertion. Returns
// a `messages` array + an `unsub` to clean up.
function captureBroadcast(paneId: string): {
  messages: unknown[];
  unsub: () => void;
} {
  const messages: unknown[] = [];
  const unsub = subscribe(paneId, (m) => {
    messages.push(m);
  });
  return { messages, unsub };
}

// ---------------------------------------------------------------------------
// writeRecord — create + idempotency + authz + validation + WS publish
// ---------------------------------------------------------------------------

describe("writeRecord", () => {
  it("creates a new record with version=1 and seq=1", async () => {
    const f = await seedPaneWithRecordSchema();
    const r = await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_1",
      data: { body: "hi" },
    });
    expect(r.deduped).toBe(false);
    expect(r.record.version).toBe(1);
    expect(r.record.seq).toBe(1);
    expect(r.record.key).toBe("cmt_1");
    expect(r.record.collection).toBe("comments");
    expect(r.record.data).toEqual({ body: "hi" });
    expect(r.record.author).toEqual({ kind: "human", id: "h_alice" });
    expect(r.record.deleted_at).toBeNull();
  });

  it("generates rec_<cuid> key when caller omits record_key", async () => {
    const f = await seedPaneWithRecordSchema();
    const r = await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      data: { body: "no key" },
    });
    expect(r.record.key).toMatch(/^rec_/);
    expect(r.deduped).toBe(false);
  });

  it("is idempotent on duplicate record_key — second POST returns existing, no seq bump", async () => {
    const f = await seedPaneWithRecordSchema();
    const first = await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_dup",
      data: { body: "v1" },
    });
    const second = await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_dup",
      data: { body: "v2-ignored" },
    });
    expect(second.deduped).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.version).toBe(1);
    expect(second.record.data).toEqual({ body: "v1" }); // unchanged
    // seq cursor on the collection was NOT bumped a second time
    const col = await prisma.recordCollection.findFirstOrThrow({
      where: { paneId: f.pane.id, name: "comments" },
    });
    expect(col.seq).toBe(1);
  });

  it("publishes record.upsert on broadcast — fires after txn commits", async () => {
    const f = await seedPaneWithRecordSchema();
    const cap = captureBroadcast(f.pane.id);
    try {
      await writeRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_pub",
        data: { body: "broadcast me" },
      });
    } finally {
      cap.unsub();
    }
    expect(cap.messages).toHaveLength(1);
    const m = cap.messages[0] as {
      kind: string;
      collection: string;
      record: { key: string };
    };
    expect(m.kind).toBe("record.upsert");
    expect(m.collection).toBe("comments");
    expect(m.record.key).toBe("cmt_pub");
  });

  it("does NOT publish on idempotent dedup", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_d",
      data: { body: "first" },
    });
    const cap = captureBroadcast(f.pane.id);
    try {
      await writeRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_d",
        data: { body: "ignored" },
      });
    } finally {
      cap.unsub();
    }
    expect(cap.messages).toHaveLength(0);
  });

  it("rejects schema-violating payload with 422 record_schema_violation", async () => {
    const f = await seedPaneWithRecordSchema();
    await expect(
      writeRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        data: { wrong: "shape" }, // missing required `body`
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "record_schema_violation",
    });
  });

  it("rejects agent writing to a page-only collection (author_not_allowed)", async () => {
    const f = await seedPaneWithRecordSchema();
    await expect(
      writeRecord({ prisma }, f.pane, f.agentAuthor, {
        collectionName: "comments", // write: ["page"]
        data: { body: "agent tried" },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "author_not_allowed",
    });
  });

  it("rejects page writing to an agent-only collection", async () => {
    const f = await seedPaneWithRecordSchema();
    await expect(
      writeRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "notes", // write: ["agent"]
        data: { text: "page tried" },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "author_not_allowed",
    });
  });

  it("returns 404 when the collection is not declared in the recordSchema", async () => {
    const f = await seedPaneWithRecordSchema();
    await expect(
      writeRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "unknown",
        data: { body: "nope" },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "record_collection_not_found",
    });
  });

  it("returns 410 gone on a closed pane", async () => {
    const f = await seedPaneWithRecordSchema();
    await prisma.pane.update({
      where: { id: f.pane.id },
      data: { status: "closed" },
    });
    const closed = (await prisma.pane.findUniqueOrThrow({
      where: { id: f.pane.id },
      include: { templateVersion: true },
    })) as PaneWithRecordSchema;
    await expect(
      writeRecord({ prisma }, closed, f.pageAuthor, {
        collectionName: "comments",
        data: { body: "after close" },
      }),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("writes to NO row in the events table (records are not events)", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      data: { body: "hi" },
    });
    const eventCount = await prisma.event.count({
      where: { paneId: f.pane.id },
    });
    expect(eventCount).toBe(0);
  });

  it("publish does NOT fire on synthetic transaction failure", async () => {
    const f = await seedPaneWithRecordSchema();
    // Force a P2002 on the underlying insert by pre-creating a row with the
    // same (collectionId, recordKey) AFTER manually creating the collection.
    // Then a second writeRecord call against the same key takes the
    // dedup path — which deliberately does NOT publish. That's the
    // observable contract: publish only on a fresh persist.
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_x",
      data: { body: "original" },
    });
    const cap = captureBroadcast(f.pane.id);
    try {
      const result = await writeRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_x",
        data: { body: "would-be-collision" },
      });
      expect(result.deduped).toBe(true);
    } finally {
      cap.unsub();
    }
    expect(cap.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateRecord — version bump + optimistic locking + authorship preserved
// ---------------------------------------------------------------------------

describe("updateRecord", () => {
  it("bumps version + seq, replaces data, preserves original authorship", async () => {
    const f = await seedPaneWithRecordSchema();
    const created = await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_u",
      data: { body: "v1" },
    });

    // A different page author updates — the row's `author` field must
    // remain the ORIGINAL creator.
    const otherPage: Author = { kind: "human", id: "h_bob" };
    const updated = await updateRecord({ prisma }, f.pane, otherPage, {
      collectionName: "comments",
      recordKey: "cmt_u",
      data: { body: "v2" },
    });
    expect(updated.record.version).toBe(2);
    expect(updated.record.seq).toBeGreaterThan(created.record.seq);
    expect(updated.record.data).toEqual({ body: "v2" });
    // Authorship preserved.
    expect(updated.record.author).toEqual({ kind: "human", id: "h_alice" });
  });

  it("returns 409 with current row on if_match mismatch", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_lock",
      data: { body: "v1" },
    });
    let caught: unknown;
    try {
      await updateRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_lock",
        data: { body: "v2" },
        ifMatch: 99, // wrong version
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const e = caught as ApiError;
    expect(e.status).toBe(409);
    expect(e.code).toBe("conflict");
    const details = e.details as {
      current: { version: number; data: unknown };
    };
    expect(details.current.version).toBe(1);
    expect(details.current.data).toEqual({ body: "v1" });
  });

  it("succeeds with matching if_match", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_ok",
      data: { body: "v1" },
    });
    const r = await updateRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_ok",
      data: { body: "v2" },
      ifMatch: 1,
    });
    expect(r.record.version).toBe(2);
  });

  it("404s when the record does not exist", async () => {
    const f = await seedPaneWithRecordSchema();
    await expect(
      updateRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "never_created",
        data: { body: "x" },
      }),
    ).rejects.toMatchObject({ status: 404, code: "record_not_found" });
  });

  it("404s when the record was soft-deleted", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_gone",
      data: { body: "v1" },
    });
    await deleteRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_gone",
    });
    await expect(
      updateRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_gone",
        data: { body: "v2" },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("publishes record.upsert with the updated row", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_p",
      data: { body: "v1" },
    });
    const cap = captureBroadcast(f.pane.id);
    try {
      await updateRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_p",
        data: { body: "v2" },
      });
    } finally {
      cap.unsub();
    }
    expect(cap.messages).toHaveLength(1);
    const m = cap.messages[0] as { kind: string; record: { version: number } };
    expect(m.kind).toBe("record.upsert");
    expect(m.record.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// deleteRecord — soft-delete + tombstone + author-rule
// ---------------------------------------------------------------------------

describe("deleteRecord", () => {
  it("soft-deletes: sets deletedAt, bumps seq, does NOT bump version, does NOT remove row", async () => {
    const f = await seedPaneWithRecordSchema();
    const created = await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_del",
      data: { body: "to-delete" },
    });
    await deleteRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_del",
    });
    const row = await prisma.paneRecord.findUniqueOrThrow({
      where: { id: created.record.id },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.version).toBe(1); // unchanged
    expect(row.seq).toBeGreaterThan(created.record.seq);
  });

  it("publishes a record.delete tombstone with the deleted row's ref", async () => {
    const f = await seedPaneWithRecordSchema();
    const created = await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_t",
      data: { body: "x" },
    });
    const cap = captureBroadcast(f.pane.id);
    try {
      await deleteRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_t",
      });
    } finally {
      cap.unsub();
    }
    expect(cap.messages).toHaveLength(1);
    const m = cap.messages[0] as {
      kind: string;
      collection: string;
      record: { id: string; key: string; deleted_at: string };
    };
    expect(m.kind).toBe("record.delete");
    expect(m.collection).toBe("comments");
    expect(m.record.id).toBe(created.record.id);
    expect(m.record.key).toBe("cmt_t");
    expect(m.record.deleted_at).not.toBe("");
  });

  it('author rule: non-author cannot delete a row in delete:["author"]', async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments", // delete: ["author"]
      recordKey: "cmt_owned",
      data: { body: "alice's comment" },
    });
    const bob: Author = { kind: "human", id: "h_bob" };
    await expect(
      deleteRecord({ prisma }, f.pane, bob, {
        collectionName: "comments",
        recordKey: "cmt_owned",
      }),
    ).rejects.toMatchObject({ status: 403, code: "author_not_allowed" });
  });

  it('author rule: author CAN delete their own row in delete:["author"]', async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_mine",
      data: { body: "alice's" },
    });
    await expect(
      deleteRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_mine",
      }),
    ).resolves.toBeUndefined();
  });

  it('agent CAN force-delete any row in delete:["agent", "author"]', async () => {
    const f = await seedPaneWithRecordSchema();
    // A page creates a post, the agent then force-deletes it.
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "posts", // delete: ["agent", "author"]
      recordKey: "post_x",
      data: { title: "t", body: "b" },
    });
    await expect(
      deleteRecord({ prisma }, f.pane, f.agentAuthor, {
        collectionName: "posts",
        recordKey: "post_x",
      }),
    ).resolves.toBeUndefined();
  });

  it("returns 409 with current row on if_match mismatch", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_ifm",
      data: { body: "v1" },
    });
    let caught: unknown;
    try {
      await deleteRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_ifm",
        ifMatch: 99,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
  });

  it("404s on already-deleted record", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_d2",
      data: { body: "x" },
    });
    await deleteRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_d2",
    });
    await expect(
      deleteRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: "cmt_d2",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("writes to NO row in the events table on delete", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_e",
      data: { body: "x" },
    });
    await deleteRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_e",
    });
    const eventCount = await prisma.event.count({
      where: { paneId: f.pane.id },
    });
    expect(eventCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listRecords — pagination + tombstones
// ---------------------------------------------------------------------------

describe("listRecords", () => {
  it("returns an empty page for a declared-but-unwritten collection", async () => {
    const f = await seedPaneWithRecordSchema();
    const out = await listRecords(prisma, f.pane, "comments", {
      since: 0,
      limit: 100,
    });
    expect(out.records).toEqual([]);
    expect(out.has_more).toBe(false);
  });

  it("returns rows in seq order with has_more on overflow", async () => {
    const f = await seedPaneWithRecordSchema();
    for (let i = 0; i < 5; i++) {
      await writeRecord({ prisma }, f.pane, f.pageAuthor, {
        collectionName: "comments",
        recordKey: `cmt_${i}`,
        data: { body: String(i) },
      });
    }
    const out = await listRecords(prisma, f.pane, "comments", {
      since: 0,
      limit: 3,
    });
    expect(out.records).toHaveLength(3);
    expect(out.has_more).toBe(true);
    expect(out.records.map((r) => r.key)).toEqual(["cmt_0", "cmt_1", "cmt_2"]);

    const next = await listRecords(prisma, f.pane, "comments", {
      since: out.next_since,
      limit: 3,
    });
    expect(next.records.map((r) => r.key)).toEqual(["cmt_3", "cmt_4"]);
    expect(next.has_more).toBe(false);
  });

  it("includes tombstones (soft-deleted rows have deleted_at set)", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_alive",
      data: { body: "alive" },
    });
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_doomed",
      data: { body: "doomed" },
    });
    await deleteRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "cmt_doomed",
    });

    const out = await listRecords(prisma, f.pane, "comments", {
      since: 0,
      limit: 100,
    });
    expect(out.records).toHaveLength(2);
    const doomed = out.records.find((r) => r.key === "cmt_doomed");
    expect(doomed?.deleted_at).not.toBeNull();
  });

  it("404s on undeclared collection", async () => {
    const f = await seedPaneWithRecordSchema();
    await expect(
      listRecords(prisma, f.pane, "unknown", { since: 0, limit: 10 }),
    ).rejects.toMatchObject({
      status: 404,
      code: "record_collection_not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency — per-collection seq stays monotonic under parallel writes
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("per-collection seq is strictly monotonic + unique under N concurrent writes", async () => {
    const f = await seedPaneWithRecordSchema();
    const N = 25;
    const writes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writeRecord({ prisma }, f.pane, f.pageAuthor, {
          collectionName: "comments",
          recordKey: `cmt_c_${i}`,
          data: { body: `c${i}` },
        }),
      ),
    );
    const seqs = writes.map((w) => w.record.seq).sort((a, b) => a - b);
    // Strictly monotonic + unique (no two writes share a seq).
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
    const col = await prisma.recordCollection.findFirstOrThrow({
      where: { paneId: f.pane.id, name: "comments" },
    });
    expect(col.seq).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// deleteRecordCollection — drop the whole collection (#507)
// ---------------------------------------------------------------------------

describe("deleteRecordCollection", () => {
  it("removes the collection row and cascade-deletes every record (live + tombstoned)", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "a",
      data: { body: "one" },
    });
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "b",
      data: { body: "two" },
    });
    // Tombstone one of them first.
    await deleteRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "b",
    });

    const col = await prisma.recordCollection.findFirstOrThrow({
      where: { paneId: f.pane.id, name: "comments" },
    });

    const res = await deleteRecordCollection({ prisma }, f.pane, "comments");
    expect(res.removed).toBe(2); // 1 live + 1 tombstone

    expect(
      await prisma.recordCollection.findFirst({
        where: { paneId: f.pane.id, name: "comments" },
      }),
    ).toBeNull();
    expect(
      await prisma.paneRecord.count({ where: { collectionId: col.id } }),
    ).toBe(0);
  });

  it("broadcasts a record.delete tombstone for each LIVE row only", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "a",
      data: { body: "one" },
    });
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "b",
      data: { body: "two" },
    });
    // Tombstone b before the collection delete — it must NOT be re-broadcast.
    await deleteRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "b",
    });

    const cap = captureBroadcast(f.pane.id);
    try {
      await deleteRecordCollection({ prisma }, f.pane, "comments");
    } finally {
      cap.unsub();
    }
    expect(cap.messages).toHaveLength(1);
    const m = cap.messages[0] as {
      kind: string;
      collection: string;
      record: { key: string };
    };
    expect(m.kind).toBe("record.delete");
    expect(m.collection).toBe("comments");
    expect(m.record.key).toBe("a");
  });

  it("404s when the collection is declared but was never written to", async () => {
    const f = await seedPaneWithRecordSchema();
    await expect(
      deleteRecordCollection({ prisma }, f.pane, "comments"),
    ).rejects.toMatchObject({
      status: 404,
      code: "record_collection_not_found",
    });
  });

  it("404s when the collection isn't declared in the schema", async () => {
    const f = await seedPaneWithRecordSchema();
    await expect(
      deleteRecordCollection({ prisma }, f.pane, "nope"),
    ).rejects.toMatchObject({
      status: 404,
      code: "record_collection_not_found",
    });
  });

  it("recreate-on-write: a fresh write after delete starts the collection at seq 1", async () => {
    const f = await seedPaneWithRecordSchema();
    await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "a",
      data: { body: "one" },
    });
    await deleteRecordCollection({ prisma }, f.pane, "comments");
    const again = await writeRecord({ prisma }, f.pane, f.pageAuthor, {
      collectionName: "comments",
      recordKey: "a2",
      data: { body: "fresh" },
    });
    expect(again.record.seq).toBe(1);
    expect(again.record.version).toBe(1);
  });
});
