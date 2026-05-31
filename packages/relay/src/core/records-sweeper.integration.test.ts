// #293 — tombstone sweeper + per-write caps.
//
// The deep writer/route semantics are covered in records.test.ts (31 unit)
// and records.e2e.test.ts (17 e2e). This file specifically pins:
//   - sweepRecordTombstones removes only tombstones older than the TTL
//   - sweepRecordTombstones leaves live rows untouched
//   - MAX_RECORDS_PER_COLLECTION enforced by writer (429)
//   - MAX_RECORD_DATA_BYTES enforced by writer (413)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import {
  deleteRecord,
  sweepRecordTombstones,
  writeRecord,
  type SurfaceWithRecordSchema,
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

const RECORD_SCHEMA = {
  $defs: {
    Comment: { type: "object", properties: { body: { type: "string" } } },
  },
  "x-pane-collections": {
    comments: {
      schema: { $ref: "#/$defs/Comment" },
      write: ["page"],
      delete: ["author"],
    },
  },
};

async function seed(): Promise<{
  surface: SurfaceWithRecordSchema;
  author: Author;
}> {
  const agent = await prisma.agent.create({
    data: {
      name: `a-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: "pane_test",
    },
  });
  const tpl = await prisma.template.create({
    data: { ownerId: agent.id, latestVersion: 1 },
  });
  const ver = await prisma.templateVersion.create({
    data: {
      templateId: tpl.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      recordSchema: RECORD_SCHEMA,
    },
  });
  const surface = await prisma.surface.create({
    data: {
      id: `sur_${randomBytes(8).toString("hex")}`,
      agentId: agent.id,
      templateVersionId: ver.id,
      title: "sweeper test",
      expiresAt: new Date(Date.now() + 3600_000),
    },
    include: { templateVersion: true },
  });
  return {
    surface: surface as SurfaceWithRecordSchema,
    author: { kind: "human", id: "h_alice" },
  };
}

describe("sweepRecordTombstones", () => {
  it("removes tombstones older than the TTL", async () => {
    const { surface, author } = await seed();
    const r = await writeRecord({ prisma }, surface, author, {
      collectionName: "comments",
      recordKey: "cmt_old",
      data: { body: "x" },
    });
    await deleteRecord({ prisma }, surface, author, {
      collectionName: "comments",
      recordKey: "cmt_old",
    });
    // Back-date the deletedAt to 10 minutes ago.
    await prisma.surfaceRecord.update({
      where: { id: r.record.id },
      data: { deletedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    // TTL = 5 minutes — the 10-min-old tombstone should be swept.
    const count = await sweepRecordTombstones(prisma, 5 * 60);
    expect(count).toBe(1);
    const after = await prisma.surfaceRecord.findUnique({
      where: { id: r.record.id },
    });
    expect(after).toBeNull();
  });

  it("leaves fresh tombstones alone", async () => {
    const { surface, author } = await seed();
    const r = await writeRecord({ prisma }, surface, author, {
      collectionName: "comments",
      recordKey: "cmt_fresh",
      data: { body: "x" },
    });
    await deleteRecord({ prisma }, surface, author, {
      collectionName: "comments",
      recordKey: "cmt_fresh",
    });

    // TTL = 1 hour — the just-now tombstone is well within.
    const count = await sweepRecordTombstones(prisma, 3600);
    expect(count).toBe(0);
    const after = await prisma.surfaceRecord.findUnique({
      where: { id: r.record.id },
    });
    expect(after).not.toBeNull();
    expect(after!.deletedAt).not.toBeNull();
  });

  it("never touches live rows (deletedAt = null)", async () => {
    const { surface, author } = await seed();
    const r = await writeRecord({ prisma }, surface, author, {
      collectionName: "comments",
      recordKey: "cmt_alive",
      data: { body: "x" },
    });

    // TTL = 1 second — even if all rows aged perfectly, live ones should
    // be ignored because deletedAt is null.
    const count = await sweepRecordTombstones(prisma, 1);
    expect(count).toBe(0);
    const after = await prisma.surfaceRecord.findUnique({
      where: { id: r.record.id },
    });
    expect(after).not.toBeNull();
  });
});

describe("writeRecord caps", () => {
  it("rejects with 413 when data exceeds MAX_RECORD_DATA_BYTES", async () => {
    const { surface, author } = await seed();
    // Tiny cap forces rejection on a small payload.
    await expect(
      writeRecord(
        {
          prisma,
          config: {
            MAX_RECORD_DATA_BYTES: 32,
            MAX_RECORDS_PER_COLLECTION: 1000,
          },
        },
        surface,
        author,
        {
          collectionName: "comments",
          recordKey: "cmt_big",
          data: { body: "x".repeat(200) },
        },
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("rejects with 429 when MAX_RECORDS_PER_COLLECTION is hit", async () => {
    const { surface, author } = await seed();
    // Cap=2; write 2 then expect the 3rd to fail.
    const cfg = {
      MAX_RECORD_DATA_BYTES: 65_536,
      MAX_RECORDS_PER_COLLECTION: 2,
    };
    for (let i = 0; i < 2; i++) {
      await writeRecord({ prisma, config: cfg }, surface, author, {
        collectionName: "comments",
        recordKey: `cmt_${i}`,
        data: { body: String(i) },
      });
    }
    await expect(
      writeRecord({ prisma, config: cfg }, surface, author, {
        collectionName: "comments",
        recordKey: "cmt_overflow",
        data: { body: "no room" },
      }),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("MAX_RECORDS_PER_COLLECTION = 0 disables the cap", async () => {
    const { surface, author } = await seed();
    const cfg = {
      MAX_RECORD_DATA_BYTES: 65_536,
      MAX_RECORDS_PER_COLLECTION: 0,
    };
    // Write more than the (disabled) cap would have allowed.
    for (let i = 0; i < 5; i++) {
      await expect(
        writeRecord({ prisma, config: cfg }, surface, author, {
          collectionName: "comments",
          recordKey: `cmt_${i}`,
          data: { body: String(i) },
        }),
      ).resolves.toBeDefined();
    }
  });

  it("tombstones do NOT count toward the live-row cap", async () => {
    const { surface, author } = await seed();
    const cfg = {
      MAX_RECORD_DATA_BYTES: 65_536,
      MAX_RECORDS_PER_COLLECTION: 2,
    };
    // Write 2 (at cap), delete 1 (live=1), write 1 more (live=2 again, OK).
    for (let i = 0; i < 2; i++) {
      await writeRecord({ prisma, config: cfg }, surface, author, {
        collectionName: "comments",
        recordKey: `cmt_${i}`,
        data: { body: String(i) },
      });
    }
    await deleteRecord({ prisma }, surface, author, {
      collectionName: "comments",
      recordKey: "cmt_0",
    });
    await expect(
      writeRecord({ prisma, config: cfg }, surface, author, {
        collectionName: "comments",
        recordKey: "cmt_after",
        data: { body: "fits" },
      }),
    ).resolves.toBeDefined();
  });
});
