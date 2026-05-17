// Integration test for runBootstrap against a real DB. Engine is whatever
// DATABASE_URL points at (sqlite file or postgres) — the CI matrix runs both.
// Verifies the acceptance criteria from
// docs/architecture/phase-1-skeleton-and-data.md (idempotency under repeated
// API_KEY runs; mint-and-print exactly once on empty; no-op with agents).

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { runBootstrap } from "./bootstrap.js";
import { hashKey } from "./keys.js";
import type { Config } from "./config.js";
import { setupTestDb, type TestDb } from "./test-helpers/db.js";

const baseConfig: Config = {
  DATABASE_URL: "",
  PORT: 3000,
  PUBLIC_URL: undefined,
  API_KEY: undefined,
  REGISTER_RATE_LIMIT: 5,
  REGISTER_RATE_WINDOW_SECONDS: 3600,
  MAX_ARTIFACT_BYTES: 2_000_000,
  MAX_EVENT_DATA_BYTES: 65_536,
  MAX_PARTICIPANTS_PER_SESSION: 32,
  DEFAULT_TTL_SECONDS: 3600,
  MAX_TTL_SECONDS: 86_400,
  TTL_SWEEP_SECONDS: 60,
  LOG_LEVEL: "error",
  publicUrl: "http://localhost:3000",
};

describe("bootstrap (integration, real DB)", () => {
  let testDb: TestDb;
  let prisma: PrismaClient;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuffer: string;

  beforeAll(async () => {
    testDb = await setupTestDb();
    prisma = new PrismaClient({ datasourceUrl: testDb.dbUrl });
    await testDb.applyMigration(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await testDb.truncateAll(prisma);
    stdoutBuffer = "";
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdoutBuffer +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("API_KEY set + empty DB: creates exactly one default agent", async () => {
    const apiKey = "pane_test1234567890abcdef1234567890ab";
    await runBootstrap(prisma, { ...baseConfig, API_KEY: apiKey });

    const rows = await prisma.agent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("default");
    expect(rows[0]!.keyHash).toBe(hashKey(apiKey));
    expect(rows[0]!.keyPrefix).toBe(apiKey.slice(0, 11));
  });

  it("API_KEY set + run twice: still exactly one default agent (idempotent upsert)", async () => {
    const apiKey = "pane_test1234567890abcdef1234567890ab";
    const cfg = { ...baseConfig, API_KEY: apiKey };

    await runBootstrap(prisma, cfg);
    await runBootstrap(prisma, cfg);

    const rows = await prisma.agent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keyHash).toBe(hashKey(apiKey));
  });

  it("no API_KEY + empty DB: mints one agent and prints the banner", async () => {
    await runBootstrap(prisma, baseConfig);

    const rows = await prisma.agent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("default");
    expect(stdoutBuffer).toContain("No API_KEY set and no agents existed");
    expect(stdoutBuffer).toMatch(/Generated one: pane_[0-9a-f]{32}/);
  });

  it("no API_KEY + DB already has agents: does nothing, no banner", async () => {
    // Seed an existing agent so count > 0.
    await prisma.agent.create({
      data: { name: "seed", keyHash: "x".repeat(64), keyPrefix: "pane_seed01" },
    });

    await runBootstrap(prisma, baseConfig);

    const rows = await prisma.agent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("seed");
    expect(stdoutBuffer).not.toContain("Generated one:");
  });

  it("no API_KEY + run twice on empty DB: mints exactly once on the first run", async () => {
    await runBootstrap(prisma, baseConfig);
    const afterFirst = await prisma.agent.count();
    expect(afterFirst).toBe(1);
    const firstBanner = stdoutBuffer;
    expect(firstBanner).toMatch(/Generated one: pane_/);

    // Reset capture and run again. Second run sees count > 0, does nothing.
    stdoutBuffer = "";
    await runBootstrap(prisma, baseConfig);

    const afterSecond = await prisma.agent.count();
    expect(afterSecond).toBe(1);
    expect(stdoutBuffer).not.toContain("Generated one:");
  });
});
