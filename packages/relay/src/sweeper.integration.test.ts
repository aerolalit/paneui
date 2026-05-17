// Integration test for the TTL sweeper (sweepExpiredSessions). Runs against
// whatever engine DATABASE_URL points at (sqlite file or postgres).
//
// Regression coverage for #57: the sweeper must invalidate the compiled-
// validator cache for every session it deletes, not just sessions removed via
// an explicit DELETE.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { EventSchema } from "./types.js";
import { setupTestDb, type TestDb } from "./test-helpers/db.js";

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

  delete (globalThis as { prisma?: PrismaClient }).prisma;

  const dbMod = await import("./db.js");
  prisma = dbMod.default;
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
  const session = await prisma.session.create({
    data: {
      id: `ses_${randomBytes(8).toString("hex")}`,
      agentId: agent.id,
      artifactType: "html-inline",
      artifactSource: "<html></html>",
      eventSchema: SCHEMA as unknown as object,
      status: "open",
      expiresAt: new Date(Date.now() + expiresInMs),
    },
  });
  return session.id;
}

// Populate the compiled-validator cache for a session by validating an event.
function warmCache(sessionId: string): void {
  validateEvent({
    sessionId,
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

  it("invalidates the validator cache for swept (expired) sessions", async () => {
    const expiredId = await seedSession(-1000);
    const liveId = await seedSession(3_600_000);

    warmCache(expiredId);
    warmCache(liveId);
    expect(__schemaCacheInternals.has(expiredId, 1)).toBe(true);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);

    const count = await sweepExpiredSessions();
    expect(count).toBe(1);

    // The expired session's compiled validators are gone; the live one stays.
    expect(__schemaCacheInternals.has(expiredId, 1)).toBe(false);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);

    expect(await prisma.session.findUnique({ where: { id: expiredId } })).toBe(
      null,
    );
  });

  it("is a no-op when nothing is expired", async () => {
    const liveId = await seedSession(3_600_000);
    warmCache(liveId);

    const count = await sweepExpiredSessions();
    expect(count).toBe(0);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);
  });
});
