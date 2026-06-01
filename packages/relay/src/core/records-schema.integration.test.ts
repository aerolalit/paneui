// #288 — Schema-only smoke test for the records foundation.
//
// The records feature has no business logic yet (validation, writers, and
// routes ship in #289 / #291 / #292). This file pins the parts of the
// schema that are easy to regress later:
//
//   1. The `record_collections.pane_id` FK is `ON DELETE CASCADE`, so a
//      pane delete takes its collections (and, transitively, its rows)
//      with it. This mirrors the existing `Event` and `Attachment` cascades
//      and is what guarantees a pane delete leaves no record-table
//      orphans.
//   2. The `surface_records.collection_id` FK is `ON DELETE CASCADE`, so
//      deleting a collection (e.g. via the pane cascade above) also
//      removes its rows.
//
// Engine-agnostic — the cascade behaviour is what matters, not the SQL
// dialect that backs it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";

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

async function seedAgent(): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: "pane_test",
    },
  });
  return agent.id;
}

async function seedPaneFor(agentId: string): Promise<string> {
  const template = await prisma.template.create({
    data: { ownerId: agentId, latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: "pan_" + randomBytes(8).toString("hex"),
      agentId,
      templateVersionId: version.id,
      title: "records cascade test pane",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return pane.id;
}

describe("records schema — cascade behaviour", () => {
  it("RecordCollection cascades on pane delete (and takes its records with it)", async () => {
    const agentId = await seedAgent();
    const paneId = await seedPaneFor(agentId);

    const collection = await prisma.recordCollection.create({
      data: { paneId, name: "posts", seq: 1 },
    });
    const record = await prisma.paneRecord.create({
      data: {
        collectionId: collection.id,
        recordKey: "post_1",
        data: { title: "hello", body: "world" },
        seq: 1,
        authorKind: "agent",
        authorId: agentId,
      },
    });

    // Sanity: both rows are visible before the delete.
    expect(
      await prisma.recordCollection.findUnique({
        where: { id: collection.id },
      }),
    ).not.toBeNull();
    expect(
      await prisma.paneRecord.findUnique({ where: { id: record.id } }),
    ).not.toBeNull();

    await prisma.pane.delete({ where: { id: paneId } });

    // Collection rides the FK to Pane (CASCADE), and its rows ride the
    // FK to RecordCollection (CASCADE) — both are gone.
    expect(
      await prisma.recordCollection.findUnique({
        where: { id: collection.id },
      }),
    ).toBeNull();
    expect(
      await prisma.paneRecord.findUnique({ where: { id: record.id } }),
    ).toBeNull();
  });

  it("PaneRecord cascades on RecordCollection delete", async () => {
    const agentId = await seedAgent();
    const paneId = await seedPaneFor(agentId);

    const collection = await prisma.recordCollection.create({
      data: { paneId, name: "comments", seq: 1 },
    });
    const r1 = await prisma.paneRecord.create({
      data: {
        collectionId: collection.id,
        recordKey: "cmt_a",
        data: { body: "a" },
        seq: 1,
        authorKind: "human",
        authorId: "h_1",
      },
    });
    const r2 = await prisma.paneRecord.create({
      data: {
        collectionId: collection.id,
        recordKey: "cmt_b",
        data: { body: "b" },
        seq: 2,
        authorKind: "human",
        authorId: "h_1",
      },
    });

    await prisma.recordCollection.delete({ where: { id: collection.id } });

    expect(
      await prisma.paneRecord.findUnique({ where: { id: r1.id } }),
    ).toBeNull();
    expect(
      await prisma.paneRecord.findUnique({ where: { id: r2.id } }),
    ).toBeNull();
  });
});
