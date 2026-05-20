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
import { seedSessionRow } from "./test-helpers/seed.js";

let testDb: TestDb;
let prisma: PrismaClient;
let closeDb: () => Promise<void>;
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
  ({ prisma, close: closeDb } = createPrismaClient(testDb.dbUrl));
  await testDb.applyMigration(prisma);

  ({ sweepExpiredSessions } = await import("./index.js"));
  ({ validateEvent, __schemaCacheInternals } =
    await import("./core/validation.js"));
});

afterAll(async () => {
  await closeDb();
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
  const { sessionId } = await seedSessionRow(prisma, {
    agentId: agent.id,
    eventSchema: SCHEMA as unknown as object,
    status: "open",
    expiresAt: new Date(Date.now() + expiresInMs),
  });
  return sessionId;
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

    const count = await sweepExpiredSessions(prisma);
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

    const count = await sweepExpiredSessions(prisma);
    expect(count).toBe(0);
    expect(__schemaCacheInternals.has(liveId, 1)).toBe(true);
  });

  // Locks in error-shape parity across engines: a unique-constraint violation
  // must surface as Prisma error code P2002 whether we're on the Rust engine
  // (sqlite path) or the `pg` driver adapter (postgres path). Piggybacks on
  // the sweeper integration fixture rather than adding a dedicated test file.
  it("surfaces unique-constraint violations as P2002 on both engines", async () => {
    const duplicateHash = randomBytes(32).toString("hex");
    const duplicatePrefix = `pane_${randomBytes(3).toString("hex")}`;
    await prisma.agent.create({
      data: {
        name: `agent-${randomBytes(4).toString("hex")}`,
        keyHash: duplicateHash,
        keyPrefix: duplicatePrefix,
      },
    });
    let caught: unknown;
    try {
      await prisma.agent.create({
        data: {
          name: `agent-${randomBytes(4).toString("hex")}`,
          keyHash: duplicateHash, // collides with the @unique key_hash above
          keyPrefix: duplicatePrefix,
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // Prisma's PrismaClientKnownRequestError exposes `code`; on the adapter
    // path the same shape must be preserved end-to-end.
    expect((caught as { code?: string }).code).toBe("P2002");
  });
});
