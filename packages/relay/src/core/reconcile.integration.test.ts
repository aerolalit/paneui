// Integration test for startup reconciliation of orphaned participant.joined
// events. Simulates an abrupt relay restart mid-session: a `joined` row exists
// with no matching `left`, and proves reconcileOrphanedParticipants(prisma) closes
// the log out by emitting a synthetic `system.participant.left`.
//
// Runs against whatever engine DATABASE_URL points at (sqlite or postgres).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import { reconcileOrphanedParticipants } from "./reconcile.js";

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
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedSession(
  status = "open",
): Promise<{ sessionId: string; agentId: string }> {
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
      eventSchema: { events: {} },
      status,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { sessionId: session.id, agentId: agent.id };
}

function joined(sessionId: string, author: { kind: string; id: string }) {
  return prisma.event.create({
    data: {
      sessionId,
      authorKind: "system",
      authorId: "system",
      type: "system.participant.joined",
      data: { author } as object,
    },
  });
}

function left(sessionId: string, author: { kind: string; id: string }) {
  return prisma.event.create({
    data: {
      sessionId,
      authorKind: "system",
      authorId: "system",
      type: "system.participant.left",
      data: { author } as object,
    },
  });
}

async function leftEvents(sessionId: string) {
  return prisma.event.findMany({
    where: { sessionId, type: "system.participant.left" },
    orderBy: { id: "asc" },
  });
}

describe("reconcileOrphanedParticipants (integration)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("emits a synthetic left for an orphaned joined after an abrupt restart", async () => {
    // Simulate a crash mid-session: joined written, close handler never ran.
    const { sessionId } = await seedSession();
    const author = { kind: "human", id: "h_0" };
    await joined(sessionId, author);

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(1);

    const lefts = await leftEvents(sessionId);
    expect(lefts).toHaveLength(1);
    expect(lefts[0]!.data).toEqual({ author });
    expect(lefts[0]!.authorKind).toBe("system");
  });

  it("leaves a cleanly-paired joined/left alone", async () => {
    const { sessionId } = await seedSession();
    const author = { kind: "agent", id: "a_0" };
    await joined(sessionId, author);
    await left(sessionId, author);

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(0);
    expect(await leftEvents(sessionId)).toHaveLength(1);
  });

  it("pairs by author: only the orphaned author gets a synthetic left", async () => {
    const { sessionId } = await seedSession();
    const agent = { kind: "agent", id: "a_0" };
    const human = { kind: "human", id: "h_0" };
    await joined(sessionId, agent);
    await left(sessionId, agent);
    await joined(sessionId, human); // orphan

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(1);

    const lefts = await leftEvents(sessionId);
    expect(lefts).toHaveLength(2);
    expect(lefts[1]!.data).toEqual({ author: human });
  });

  it("handles repeated connects: nets joined vs left per author", async () => {
    // Author joined three times, left twice -> one orphan remains.
    const { sessionId } = await seedSession();
    const author = { kind: "human", id: "h_0" };
    await joined(sessionId, author);
    await left(sessionId, author);
    await joined(sessionId, author);
    await joined(sessionId, author);
    await left(sessionId, author);

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(1);
    expect(await leftEvents(sessionId)).toHaveLength(3);
  });

  it("ignores sessions that are not open", async () => {
    const { sessionId } = await seedSession("closed");
    await joined(sessionId, { kind: "human", id: "h_0" });

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(0);
    expect(await leftEvents(sessionId)).toHaveLength(0);
  });

  it("is idempotent: a second run finds nothing to reconcile", async () => {
    const { sessionId } = await seedSession();
    await joined(sessionId, { kind: "human", id: "h_0" });

    expect(await reconcileOrphanedParticipants(prisma)).toBe(1);
    expect(await reconcileOrphanedParticipants(prisma)).toBe(0);
    expect(await leftEvents(sessionId)).toHaveLength(1);
  });
});
