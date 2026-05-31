// Integration test for the TTL sweeper (sweepExpiredSessions). Runs against
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
import { seedSessionRow } from "./test-helpers/seed.js";

let testDb: TestDb;
let prisma: PrismaClient;
let sweepExpiredSessions: typeof import("./index.js").sweepExpiredSessions;
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

  ({ sweepExpiredSessions } = await import("./index.js"));
  ({ validateEvent, __schemaCacheInternals } =
    await import("./core/validation.js"));
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedSession(expiresInMs: number): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
    },
  });
  const { surfaceId } = await seedSessionRow(prisma, {
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

describe("sweepExpiredSessions (integration, real DB)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
    __schemaCacheInternals.clear();
  });

  it("invalidates the validator cache for swept (expired) surfaces", async () => {
    const expiredId = await seedSession(-1000);
    const liveId = await seedSession(3_600_000);

    warmCache(expiredId);
    warmCache(liveId);
    expect(__schemaCacheInternals.has(expiredId, 1)).toBe(true);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);

    const count = await sweepExpiredSessions(prisma);
    expect(count).toBe(1);

    // The expired surface's compiled validators are gone; the live one stays.
    expect(__schemaCacheInternals.has(expiredId, 1)).toBe(false);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);

    expect(await prisma.surface.findUnique({ where: { id: expiredId } })).toBe(
      null,
    );
  });

  it("is a no-op when nothing is expired", async () => {
    const liveId = await seedSession(3_600_000);
    warmCache(liveId);

    const count = await sweepExpiredSessions(prisma);
    expect(count).toBe(0);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);
  });

  // ---- anonymous-template orphan cleanup --------------------------------

  it("hard-deletes the anonymous template once its last surface is swept", async () => {
    // seedSession() uses seedArtifact() with no name/slug — anonymous.
    const expiredId = await seedSession(-1000);
    const surfaceBefore = await prisma.surface.findUnique({
      where: { id: expiredId },
      select: { templateVersionId: true },
    });
    const versionBefore = await prisma.templateVersion.findUnique({
      where: { id: surfaceBefore!.templateVersionId },
      select: { templateId: true },
    });
    const templateId = versionBefore!.templateId;

    await sweepExpiredSessions(prisma);

    // Surface + its anonymous template are both gone (template cascade
    // deletes its versions).
    expect(await prisma.surface.findUnique({ where: { id: expiredId } })).toBe(
      null,
    );
    expect(
      await prisma.template.findUnique({ where: { id: templateId } }),
    ).toBe(null);
  });

  it("preserves a named template even when its only surface is swept", async () => {
    const agent = await prisma.agent.create({
      data: {
        name: `agent-${randomBytes(4).toString("hex")}`,
        keyHash: randomBytes(32).toString("hex"),
        keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
      },
    });
    // Named (non-anonymous) template — has a name even if no slug.
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
    const { surfaceId } = await seedSessionRow(prisma, {
      agentId: agent.id,
      templateVersionId: version.id,
      status: "open",
      expiresAt: new Date(Date.now() - 1000),
    });

    await sweepExpiredSessions(prisma);

    // Surface is swept, but the named template (and its version) survives —
    // future surfaces may reference it via id/slug.
    expect(await prisma.surface.findUnique({ where: { id: surfaceId } })).toBe(
      null,
    );
    expect(
      await prisma.template.findUnique({ where: { id: template.id } }),
    ).not.toBe(null);
    expect(
      await prisma.templateVersion.findUnique({ where: { id: version.id } }),
    ).not.toBe(null);
  });

  it("preserves an anonymous template still referenced by an active surface", async () => {
    // Two surfaces share the same anonymous template — one expires, one lives.
    const agent = await prisma.agent.create({
      data: {
        name: `agent-${randomBytes(4).toString("hex")}`,
        keyHash: randomBytes(32).toString("hex"),
        keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
      },
    });
    const { surfaceId: expiredId, templateVersionId } = await seedSessionRow(
      prisma,
      {
        agentId: agent.id,
        eventSchema: SCHEMA as unknown as object,
        status: "open",
        expiresAt: new Date(Date.now() - 1000),
      },
    );
    const { surfaceId: liveId } = await seedSessionRow(prisma, {
      agentId: agent.id,
      templateVersionId,
      status: "open",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const versionRow = await prisma.templateVersion.findUnique({
      where: { id: templateVersionId },
      select: { templateId: true },
    });
    const templateId = versionRow!.templateId;

    await sweepExpiredSessions(prisma);

    // The expired surface is gone. The live one + the shared anonymous
    // template both survive — sweep must check that NO surface still
    // references any of the template's versions, not just the swept one.
    expect(await prisma.surface.findUnique({ where: { id: expiredId } })).toBe(
      null,
    );
    expect(await prisma.surface.findUnique({ where: { id: liveId } })).not.toBe(
      null,
    );
    expect(
      await prisma.template.findUnique({ where: { id: templateId } }),
    ).not.toBe(null);
  });
});
