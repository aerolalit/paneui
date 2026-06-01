// Integration test for the TTL sweeper (sweepExpiredPanes). Runs against
// whatever engine DATABASE_URL points at (sqlite file or postgres).
//
// Regression coverage for #57: the sweeper must invalidate the compiled-
// validator cache for every pane it deletes, not just panes removed via
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

  it("invalidates the validator cache for swept (expired) panes", async () => {
    const expiredId = await seedPane(-1000);
    const liveId = await seedPane(3_600_000);

    warmCache(expiredId);
    warmCache(liveId);
    expect(__schemaCacheInternals.has(expiredId, 1)).toBe(true);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);

    const count = await sweepExpiredPanes(prisma);
    expect(count).toBe(1);

    // The expired pane's compiled validators are gone; the live one stays.
    expect(__schemaCacheInternals.has(expiredId, 1)).toBe(false);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);

    expect(await prisma.pane.findUnique({ where: { id: expiredId } })).toBe(
      null,
    );
  });

  it("is a no-op when nothing is expired", async () => {
    const liveId = await seedPane(3_600_000);
    warmCache(liveId);

    const count = await sweepExpiredPanes(prisma);
    expect(count).toBe(0);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);
  });

  // ---- anonymous-template orphan cleanup --------------------------------

  it("hard-deletes the anonymous template once its last pane is swept", async () => {
    // seedPane() uses seedArtifact() with no name/slug — anonymous.
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

    // Pane + its anonymous template are both gone (template cascade
    // deletes its versions).
    expect(await prisma.pane.findUnique({ where: { id: expiredId } })).toBe(
      null,
    );
    expect(
      await prisma.template.findUnique({ where: { id: templateId } }),
    ).toBe(null);
  });

  it("preserves a named template even when its only pane is swept", async () => {
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
    const { paneId } = await seedPaneRow(prisma, {
      agentId: agent.id,
      templateVersionId: version.id,
      status: "open",
      expiresAt: new Date(Date.now() - 1000),
    });

    await sweepExpiredPanes(prisma);

    // Pane is swept, but the named template (and its version) survives —
    // future panes may reference it via id/slug.
    expect(await prisma.pane.findUnique({ where: { id: paneId } })).toBe(null);
    expect(
      await prisma.template.findUnique({ where: { id: template.id } }),
    ).not.toBe(null);
    expect(
      await prisma.templateVersion.findUnique({ where: { id: version.id } }),
    ).not.toBe(null);
  });

  it("preserves an anonymous template still referenced by an active pane", async () => {
    // Two panes share the same anonymous template — one expires, one lives.
    const agent = await prisma.agent.create({
      data: {
        name: `agent-${randomBytes(4).toString("hex")}`,
        keyHash: randomBytes(32).toString("hex"),
        keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
      },
    });
    const { paneId: expiredId, templateVersionId } = await seedPaneRow(prisma, {
      agentId: agent.id,
      eventSchema: SCHEMA as unknown as object,
      status: "open",
      expiresAt: new Date(Date.now() - 1000),
    });
    const { paneId: liveId } = await seedPaneRow(prisma, {
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

    await sweepExpiredPanes(prisma);

    // The expired pane is gone. The live one + the shared anonymous
    // template both survive — sweep must check that NO pane still
    // references any of the template's versions, not just the swept one.
    expect(await prisma.pane.findUnique({ where: { id: expiredId } })).toBe(
      null,
    );
    expect(await prisma.pane.findUnique({ where: { id: liveId } })).not.toBe(
      null,
    );
    expect(
      await prisma.template.findUnique({ where: { id: templateId } }),
    ).not.toBe(null);
  });
});
