// Integration test for the TTL sweeper (sweepExpiredSurfaces). Runs against
// whatever engine DATABASE_URL points at (sqlite file or postgres).
//
// Regression coverage for #57: the sweeper must invalidate the compiled-
// validator cache for every surface it deletes, not just surfaces removed via
// an explicit DELETE.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { EventSchema } from "./types.js";
import { setupTestDb, type TestDb } from "./test-helpers/db.js";
import { seedSurfaceRow } from "./test-helpers/seed.js";

let testDb: TestDb;
let prisma: PrismaClient;
let sweepExpiredSurfaces: typeof import("./index.js").sweepExpiredSurfaces;
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

  ({ sweepExpiredSurfaces } = await import("./index.js"));
  ({ validateEvent, __schemaCacheInternals } =
    await import("./core/validation.js"));
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedSurface(expiresInMs: number): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
    },
  });
  const { surfaceId } = await seedSurfaceRow(prisma, {
    agentId: agent.id,
    eventSchema: SCHEMA as unknown as object,
    status: "open",
    expiresAt: new Date(Date.now() + expiresInMs),
  });
  return surfaceId;
}

// Populate the compiled-validator cache for a surface by validating an event.
function warmCache(surfaceId: string): void {
  validateEvent({
    surfaceId,
    schemaVersion: 1,
    schema: SCHEMA,
    type: "review.commentAdded",
    data: { body: "hello" },
    authorKind: "agent",
  });
}

describe("sweepExpiredSurfaces (integration, real DB)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
    __schemaCacheInternals.clear();
  });

  // #303 — semantics changed: TTL sweep now SOFT-deletes (sets deleted_at)
  // instead of hard-deleting. The hard-delete sweeper from #304 reclaims the
  // row after the retention window. Anonymous-template orphan cleanup also
  // moves to #304; templates whose surfaces are merely soft-deleted are
  // still referenced by extant rows, so the orphan predicate returns false
  // — premature cleanup avoided.

  it("soft-deletes expired surfaces (row preserved, deleted_at set)", async () => {
    const expiredId = await seedSurface(-1000);
    const liveId = await seedSurface(3_600_000);

    warmCache(expiredId);
    warmCache(liveId);

    const count = await sweepExpiredSurfaces(prisma);
    expect(count).toBe(1);

    // Expired surface row STAYS — but with deleted_at set.
    const expired = await prisma.surface.findUnique({
      where: { id: expiredId },
    });
    expect(expired).not.toBe(null);
    expect(expired!.deletedAt).not.toBe(null);

    // Live surface untouched.
    const live = await prisma.surface.findUnique({ where: { id: liveId } });
    expect(live!.deletedAt).toBe(null);

    // Validator cache: expired entry dropped, live entry preserved.
    expect(__schemaCacheInternals.has(expiredId, 1)).toBe(false);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);
  });

  it("appends one deletion_log row per soft-deleted surface", async () => {
    const expiredId1 = await seedSurface(-2000);
    const expiredId2 = await seedSurface(-1000);

    await sweepExpiredSurfaces(prisma);

    const logs = await prisma.deletionLog.findMany({
      where: { entityType: "surface", phase: "soft_deleted" },
      orderBy: { at: "asc" },
    });
    expect(logs.map((l) => l.entityId).sort()).toEqual(
      [expiredId1, expiredId2].sort(),
    );
    for (const l of logs) {
      expect(l.reason).toBe("ttl_expired");
      expect(l.ownerAgentId).not.toBe(null);
    }
  });

  it("is idempotent — second tick is a no-op (no double-soft-delete, no double log)", async () => {
    await seedSurface(-1000);

    const first = await sweepExpiredSurfaces(prisma);
    expect(first).toBe(1);

    const second = await sweepExpiredSurfaces(prisma);
    expect(second).toBe(0);

    const logCount = await prisma.deletionLog.count({
      where: { entityType: "surface", phase: "soft_deleted" },
    });
    expect(logCount).toBe(1);
  });

  it("is a no-op when nothing is expired", async () => {
    const liveId = await seedSurface(3_600_000);
    warmCache(liveId);

    const count = await sweepExpiredSurfaces(prisma);
    expect(count).toBe(0);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);
  });

  // ---- anonymous-template-orphan cleanup deferred to #304 -------------

  it("does NOT hard-delete the anonymous template (cleanup moved to #304's hard-delete sweeper)", async () => {
    // seedSurface uses seedArtifact with no name/slug — anonymous.
    const expiredId = await seedSurface(-1000);
    const surfaceBefore = await prisma.surface.findUnique({
      where: { id: expiredId },
      select: { templateVersionId: true },
    });
    const versionBefore = await prisma.templateVersion.findUnique({
      where: { id: surfaceBefore!.templateVersionId },
      select: { templateId: true },
    });
    const templateId = versionBefore!.templateId;

    await sweepExpiredSurfaces(prisma);

    // Under #303 the surface is only soft-deleted, so the template is still
    // referenced (the row exists) and the orphan predicate is correctly
    // false. Template stays. #304's hard-delete sweeper will reclaim both.
    expect(
      await prisma.template.findUnique({ where: { id: templateId } }),
    ).not.toBe(null);
  });

  it("does NOT touch a named template whose only surface is soft-deleted", async () => {
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
    const { surfaceId } = await seedSurfaceRow(prisma, {
      agentId: agent.id,
      templateVersionId: version.id,
      status: "open",
      expiresAt: new Date(Date.now() - 1000),
    });

    await sweepExpiredSurfaces(prisma);

    // Surface soft-deleted, template + version both still active.
    const s = await prisma.surface.findUnique({ where: { id: surfaceId } });
    expect(s!.deletedAt).not.toBe(null);
    expect(
      await prisma.template.findUnique({ where: { id: template.id } }),
    ).not.toBe(null);
    expect(
      await prisma.templateVersion.findUnique({ where: { id: version.id } }),
    ).not.toBe(null);
  });
});
