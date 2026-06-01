// Integration test for the TTL sweeper (sweepExpiredPanes). Runs against
// whatever engine DATABASE_URL points at (sqlite file or postgres).
//
// #303 — the sweeper now SOFT-DELETES expired panes (sets `deleted_at`
// and writes a DeletionLog audit row) instead of hard-deleting them. The
// hard-delete sweeper (#304) reclaims them after the retention window.
//
// Regression coverage for #57: the sweeper must invalidate the compiled-
// validator cache for every pane it sweeps, not just panes removed via
// an explicit DELETE.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { EventSchema } from "./types.js";
import { setupTestDb, type TestDb } from "./test-helpers/db.js";
import { seedPaneRow } from "./test-helpers/seed.js";

let testDb: TestDb;
let prisma: PrismaClient;
let sweepExpiredPanes: typeof import("./index.js").sweepExpiredPanes;
let validateEvent: typeof import("./core/validation.js").validateEvent;
let __schemaCacheInternals: typeof import("./core/validation.js").__schemaCacheInternals;

const SCHEMA: EventSchema = {
  events: {
    "review.commentAdded": {
      payload: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      emittedBy: ["page", "agent"],
    },
  },
};

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  const { createPrismaClient } = await import("./db.js");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);

  ({ sweepExpiredPanes } = await import("./index.js"));
  ({ validateEvent, __schemaCacheInternals } =
    await import("./core/validation.js"));
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedPane(expiresInMs: number): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
    },
  });
  const { paneId } = await seedPaneRow(prisma, {
    agentId: agent.id,
    eventSchema: SCHEMA as unknown as object,
    status: "open",
    expiresAt: new Date(Date.now() + expiresInMs),
  });
  return paneId;
}

// Populate the compiled-validator cache for a pane by validating an event.
function warmCache(paneId: string): void {
  validateEvent({
    paneId,
    schemaVersion: 1,
    schema: SCHEMA,
    type: "review.commentAdded",
    data: { body: "hello" },
    authorKind: "agent",
  });
}

describe("sweepExpiredPanes (integration, real DB)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
    __schemaCacheInternals.clear();
  });

  it("soft-deletes expired panes (sets deleted_at, leaves the row)", async () => {
    const expiredId = await seedPane(-1000);
    const liveId = await seedPane(3_600_000);

    const count = await sweepExpiredPanes(prisma);
    expect(count).toBe(1);

    // Expired pane is still in the table but marked deleted_at.
    const expiredRow = await prisma.pane.findUnique({
      where: { id: expiredId },
    });
    expect(expiredRow).not.toBeNull();
    expect(expiredRow?.deletedAt).not.toBeNull();

    // Live pane untouched.
    const liveRow = await prisma.pane.findUnique({ where: { id: liveId } });
    expect(liveRow?.deletedAt).toBeNull();
  });

  it("writes a DeletionLog row per swept pane (phase=soft_deleted, reason=ttl_expired)", async () => {
    const expiredId = await seedPane(-1000);

    await sweepExpiredPanes(prisma);

    const auditRow = await prisma.deletionLog.findFirst({
      where: { entityType: "pane", entityId: expiredId },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.phase).toBe("soft_deleted");
    expect(auditRow?.reason).toBe("ttl_expired");
  });

  it("invalidates the validator cache for soft-deleted panes", async () => {
    const expiredId = await seedPane(-1000);
    const liveId = await seedPane(3_600_000);

    warmCache(expiredId);
    warmCache(liveId);
    expect(__schemaCacheInternals.has(expiredId, 1)).toBe(true);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);

    await sweepExpiredPanes(prisma);

    expect(__schemaCacheInternals.has(expiredId, 1)).toBe(false);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);
  });

  it("is idempotent — a second tick over already soft-deleted rows is a no-op", async () => {
    const expiredId = await seedPane(-1000);
    const first = await sweepExpiredPanes(prisma);
    expect(first).toBe(1);

    const second = await sweepExpiredPanes(prisma);
    expect(second).toBe(0);

    // Audit table still has exactly one row for this pane — no double-log.
    const auditCount = await prisma.deletionLog.count({
      where: { entityType: "pane", entityId: expiredId },
    });
    expect(auditCount).toBe(1);
  });

  it("is a no-op when nothing is expired", async () => {
    const liveId = await seedPane(3_600_000);
    warmCache(liveId);

    const count = await sweepExpiredPanes(prisma);
    expect(count).toBe(0);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);
  });

  it("preserves anonymous templates under soft-delete (orphan reclaim moves to #304)", async () => {
    const expiredId = await seedPane(-1000);
    const paneBefore = await prisma.pane.findUnique({
      where: { id: expiredId },
      select: { templateVersionId: true },
    });
    const versionBefore = await prisma.templateVersion.findUnique({
      where: { id: paneBefore!.templateVersionId },
      select: { templateId: true },
    });
    const templateId = versionBefore!.templateId;

    await sweepExpiredPanes(prisma);

    // Anonymous template is preserved under soft-delete — the pane row
    // still exists so the orphan predicate (versions.none.panes.some)
    // correctly returns false. The hard-delete sweeper (#304) reclaims
    // anonymous templates once their last pane is hard-deleted.
    expect(
      await prisma.template.findUnique({ where: { id: templateId } }),
    ).not.toBeNull();
  });

  it("preserves a named template under soft-delete", async () => {
    const agent = await prisma.agent.create({
      data: {
        name: `agent-${randomBytes(4).toString("hex")}`,
        keyHash: randomBytes(32).toString("hex"),
        keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
      },
    });
    const template = await prisma.template.create({
      data: {
        ownerId: agent.id,
        name: "PR Review",
        slug: null,
        latestVersion: 1,
      },
    });
    const version = await prisma.templateVersion.create({
      data: {
        templateId: template.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<html></html>",
        eventSchema: SCHEMA as unknown as object,
      },
    });
    const { paneId } = await seedPaneRow(prisma, {
      agentId: agent.id,
      templateVersionId: version.id,
      status: "open",
      expiresAt: new Date(Date.now() - 1000),
    });

    await sweepExpiredPanes(prisma);

    // Pane soft-deleted; named template + its version survive.
    const paneRow = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(paneRow?.deletedAt).not.toBeNull();
    expect(
      await prisma.template.findUnique({ where: { id: template.id } }),
    ).not.toBeNull();
    expect(
      await prisma.templateVersion.findUnique({ where: { id: version.id } }),
    ).not.toBeNull();
  });
});
