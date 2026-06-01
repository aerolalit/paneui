// Integration test for startup reconciliation of orphaned participant.joined
// events. Simulates an abrupt relay restart mid-pane: a `joined` row exists
// with no matching `left`, and proves reconcileOrphanedParticipants(prisma) closes
// the log out by emitting a synthetic `system.participant.left`.
//
// Runs against whatever engine DATABASE_URL points at (sqlite or postgres).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { seedPaneRow } from "../test-helpers/seed.js";
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

async function seedPane(
  status = "open",
): Promise<{ paneId: string; agentId: string }> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
    },
  });
  const { paneId } = await seedPaneRow(prisma, {
    agentId: agent.id,
    eventSchema: { events: {} },
    status: status as "open" | "closed",
  });
  return { paneId, agentId: agent.id };
}

function joined(paneId: string, author: { kind: string; id: string }) {
  return prisma.event.create({
    data: {
      paneId,
      authorKind: "system",
      authorId: "system",
      type: "system.participant.joined",
      data: { author } as object,
    },
  });
}

function left(paneId: string, author: { kind: string; id: string }) {
  return prisma.event.create({
    data: {
      paneId,
      authorKind: "system",
      authorId: "system",
      type: "system.participant.left",
      data: { author } as object,
    },
  });
}

async function leftEvents(paneId: string) {
  return prisma.event.findMany({
    where: { paneId, type: "system.participant.left" },
    orderBy: { id: "asc" },
  });
}

describe("reconcileOrphanedParticipants (integration)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("emits a synthetic left for an orphaned joined after an abrupt restart", async () => {
    // Simulate a crash mid-pane: joined written, close handler never ran.
    const { paneId } = await seedPane();
    const author = { kind: "human", id: "h_0" };
    await joined(paneId, author);

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(1);

    const lefts = await leftEvents(paneId);
    expect(lefts).toHaveLength(1);
    expect(lefts[0]!.data).toEqual({ author });
    expect(lefts[0]!.authorKind).toBe("system");
  });

  it("leaves a cleanly-paired joined/left alone", async () => {
    const { paneId } = await seedPane();
    const author = { kind: "agent", id: "a_0" };
    await joined(paneId, author);
    await left(paneId, author);

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(0);
    expect(await leftEvents(paneId)).toHaveLength(1);
  });

  it("pairs by author: only the orphaned author gets a synthetic left", async () => {
    const { paneId } = await seedPane();
    const agent = { kind: "agent", id: "a_0" };
    const human = { kind: "human", id: "h_0" };
    await joined(paneId, agent);
    await left(paneId, agent);
    await joined(paneId, human); // orphan

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(1);

    const lefts = await leftEvents(paneId);
    expect(lefts).toHaveLength(2);
    expect(lefts[1]!.data).toEqual({ author: human });
  });

  it("handles repeated connects: nets joined vs left per author", async () => {
    // Author joined three times, left twice -> one orphan remains.
    const { paneId } = await seedPane();
    const author = { kind: "human", id: "h_0" };
    await joined(paneId, author);
    await left(paneId, author);
    await joined(paneId, author);
    await joined(paneId, author);
    await left(paneId, author);

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(1);
    expect(await leftEvents(paneId)).toHaveLength(3);
  });

  it("ignores panes that are not open", async () => {
    const { paneId } = await seedPane("closed");
    await joined(paneId, { kind: "human", id: "h_0" });

    const written = await reconcileOrphanedParticipants(prisma);
    expect(written).toBe(0);
    expect(await leftEvents(paneId)).toHaveLength(0);
  });

  it("is idempotent: a second run finds nothing to reconcile", async () => {
    const { paneId } = await seedPane();
    await joined(paneId, { kind: "human", id: "h_0" });

    expect(await reconcileOrphanedParticipants(prisma)).toBe(1);
    expect(await reconcileOrphanedParticipants(prisma)).toBe(0);
    expect(await leftEvents(paneId)).toHaveLength(1);
  });
});
