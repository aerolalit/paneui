// Integration test for the per-surface event cap (abuse control B3).
//
// MAX_EVENTS_PER_SESSION is supplied via the config injected into writeEvent()'s
// deps, so the small cap is just passed straight to loadConfig() — no
// module-singleton juggling required.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Author } from "../types.js";
import { ApiError } from "../http/errors.js";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { seedSurfaceRow } from "../test-helpers/seed.js";
import { createPrismaClient } from "../db.js";
import { loadConfig, type Config } from "../config.js";
import {
  writeEvent,
  type SurfaceWithArtifactVersion,
  type WriteEventInput,
} from "./events.js";

let testDb: TestDb;
let prisma: PrismaClient;
let config: Config;

const CAP = 5;

// Thin wrapper binding writeEvent to the injected { prisma, config } deps.
function we(
  surface: SurfaceWithArtifactVersion,
  author: Author,
  input: WriteEventInput,
) {
  return writeEvent({ prisma, config }, surface, author, input);
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

async function seedSurface(): Promise<SurfaceWithArtifactVersion> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
    },
  });
  const { surfaceId } = await seedSurfaceRow(prisma, {
    agentId: agent.id,
    eventSchema: {
      events: {
        ping: { payload: { type: "object" }, emittedBy: ["page", "agent"] },
      },
    },
  });
  const surface = await prisma.surface.findUniqueOrThrow({
    where: { id: surfaceId },
    include: { templateVersion: true },
  });
  return surface;
}

const author: Author = { kind: "agent", id: "a1" };

describe("per-surface event cap", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects events once the surface reaches MAX_EVENTS_PER_SESSION", async () => {
    const surface = await seedSurface();
    for (let i = 0; i < CAP; i++) {
      await we(surface, author, { type: "ping", data: {} });
    }
    await expect(
      we(surface, author, { type: "ping", data: {} }),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("caps are per-surface — a second surface is unaffected", async () => {
    const a = await seedSurface();
    const b = await seedSurface();
    for (let i = 0; i < CAP; i++) {
      await we(a, author, { type: "ping", data: {} });
    }
    await expect(
      we(a, author, { type: "ping", data: {} }),
    ).rejects.toBeInstanceOf(ApiError);
    // Surface b has its own independent count.
    const { event } = await we(b, author, { type: "ping", data: {} });
    expect(event.id).toBeTruthy();
  });
});
