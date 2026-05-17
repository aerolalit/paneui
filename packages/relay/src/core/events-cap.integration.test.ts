// Integration test for the per-session event cap (abuse control B3).
//
// MAX_EVENTS_PER_SESSION is supplied via the config injected into writeEvent()'s
// deps, so the small cap is just passed straight to loadConfig() — no
// module-singleton juggling required.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient, Session } from "@prisma/client";
import type { Author } from "../types.js";
import { ApiError } from "../http/errors.js";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import { loadConfig, type Config } from "../config.js";
import { writeEvent, type WriteEventInput } from "./events.js";

let testDb: TestDb;
let prisma: PrismaClient;
let config: Config;

const CAP = 5;

// Thin wrapper binding writeEvent to the injected { prisma, config } deps.
function we(session: Session, author: Author, input: WriteEventInput) {
  return writeEvent({ prisma, config }, session, author, input);
}

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  prisma = createPrismaClient(testDb.dbUrl);
  config = loadConfig({
    DATABASE_URL: testDb.dbUrl,
    MAX_EVENTS_PER_SESSION: String(CAP),
  });
  await testDb.applyMigration(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedSession(): Promise<Session> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
    },
  });
  return prisma.session.create({
    data: {
      id: `ses_${randomBytes(8).toString("hex")}`,
      agentId: agent.id,
      artifactType: "html-inline",
      artifactSource: "<html></html>",
      eventSchema: {
        events: {
          ping: { payload: { type: "object" }, emittedBy: ["page", "agent"] },
        },
      },
      status: "open",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

const author: Author = { kind: "agent", id: "a1" };

describe("per-session event cap", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects events once the session reaches MAX_EVENTS_PER_SESSION", async () => {
    const session = await seedSession();
    for (let i = 0; i < CAP; i++) {
      await we(session, author, { type: "ping", data: {} });
    }
    await expect(
      we(session, author, { type: "ping", data: {} }),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("caps are per-session — a second session is unaffected", async () => {
    const a = await seedSession();
    const b = await seedSession();
    for (let i = 0; i < CAP; i++) {
      await we(a, author, { type: "ping", data: {} });
    }
    await expect(
      we(a, author, { type: "ping", data: {} }),
    ).rejects.toBeInstanceOf(ApiError);
    // Session b has its own independent count.
    const { event } = await we(b, author, { type: "ping", data: {} });
    expect(event.id).toBeTruthy();
  });
});
