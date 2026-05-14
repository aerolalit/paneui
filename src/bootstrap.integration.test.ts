// Integration test for runBootstrap against a real SQLite DB.
// Spins up a fresh tmpdir per test, applies the init migration in-process,
// then exercises the three bootstrap branches against actual rows. Verifies the
// acceptance criteria from docs/architecture/phase-1-skeleton-and-data.md
// (idempotency under repeated API_KEY runs; mint-and-print exactly once when
// the DB is empty; no-op when agents already exist).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap } from "./bootstrap.js";
import { hashKey } from "./keys.js";
import type { Config } from "./config.js";

const MIGRATION_SQL_PATH = "prisma/migrations/20260513163701_init/migration.sql";

const baseConfig: Config = {
  DATABASE_URL: "",
  PORT: 3000,
  PUBLIC_URL: undefined,
  API_KEY: undefined,
  REGISTRATION_SECRET: undefined,
  MAX_ARTIFACT_BYTES: 2_000_000,
  MAX_EVENT_DATA_BYTES: 65_536,
  MAX_PARTICIPANTS_PER_SESSION: 32,
  DEFAULT_TTL_SECONDS: 3600,
  MAX_TTL_SECONDS: 86_400,
  TTL_SWEEP_SECONDS: 60,
  LOG_LEVEL: "error",
  publicUrl: "http://localhost:3000",
};

async function applyMigration(prisma: PrismaClient): Promise<void> {
  const raw = readFileSync(MIGRATION_SQL_PATH, "utf8");
  // Strip `-- ...` line comments first; otherwise a leading `-- CreateTable`
  // makes the whole statement start with `--` after `;`-split.
  const cleaned = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const statements = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
}

describe("bootstrap (integration, real SQLite)", () => {
  let dir: string;
  let prisma: PrismaClient;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuffer: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pane-test-"));
    const dbUrl = `file:${join(dir, "test.db")}`;
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await applyMigration(prisma);

    stdoutBuffer = "";
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdoutBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
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
