// Engine-aware test DB setup. Reads DATABASE_URL to decide between sqlite
// (file:./test.db in tmpdir) and postgresql (uses a fresh schema namespace per
// test file so parallel test files don't collide on the same Postgres database).
//
// Usage from a test file (call BEFORE any `await import("../db.js")`):
//
//   const { dbUrl, cleanup } = await setupTestDb();
//   process.env.DATABASE_URL = dbUrl;
//   const { default: prisma } = await import("../db.js");
//
// Why this pattern instead of taking a prisma instance: the rest of the codebase
// imports the singleton `prisma` from src/db.ts (~8 call sites). Refactoring to
// dependency-inject prisma everywhere is a bigger change than env-vars; this
// helper keeps the production code untouched.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

export type Engine = "sqlite" | "postgresql";

function detectEngine(url: string | undefined): Engine {
  if (!url) return "sqlite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return "postgresql";
  return "sqlite";
}

function migrationsDir(engine: Engine): string {
  return engine === "postgresql" ? "prisma/migrations-postgres" : "prisma/migrations";
}

// Picks the highest-timestamp directory under the relevant migrations folder.
// In v1 there is only one migration; this lets the harness keep working if the
// schema evolves.
function findInitMigrationSql(engine: Engine): string {
  const dir = migrationsDir(engine);
  const entries = readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
  if (entries.length === 0) throw new Error(`no migrations found under ${dir}`);
  entries.sort();
  return join(dir, entries[entries.length - 1]!, "migration.sql");
}

async function applyMigration(prisma: PrismaClient, engine: Engine): Promise<void> {
  const raw = readFileSync(findInitMigrationSql(engine), "utf8");
  const cleaned = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const stmt of cleaned.split(";").map((s) => s.trim()).filter(Boolean)) {
    await prisma.$executeRawUnsafe(stmt);
  }
}

export interface TestDb {
  /** Connection URL to put into DATABASE_URL before importing src/db.ts. */
  dbUrl: string;
  /** Detected engine — for tests that need to branch on it. */
  engine: Engine;
  /** Apply the init migration. Call once per test file after dbUrl is set. */
  applyMigration: (prisma: PrismaClient) => Promise<void>;
  /** Drop all rows in dependency order — call from beforeEach. */
  truncateAll: (prisma: PrismaClient) => Promise<void>;
  /** Tear down per-file state (tmpdir for sqlite, schema for postgres). */
  cleanup: () => Promise<void>;
}

/**
 * Set up a per-file test database.
 * - sqlite: opens a fresh file in a tmpdir; deletes the tmpdir on cleanup.
 * - postgresql: uses the existing DATABASE_URL, but isolates this file's data
 *   inside a freshly-created schema (search_path) so parallel test files don't
 *   step on each other.
 */
export async function setupTestDb(): Promise<TestDb> {
  const engine = detectEngine(process.env.DATABASE_URL);

  if (engine === "sqlite") {
    const dir = mkdtempSync(join(tmpdir(), "pane-test-"));
    const dbUrl = `file:${join(dir, "test.db")}`;
    return {
      dbUrl,
      engine,
      applyMigration: (p) => applyMigration(p, "sqlite"),
      truncateAll: async (p) => {
        await p.event.deleteMany();
        await p.participant.deleteMany();
        await p.session.deleteMany();
        await p.agent.deleteMany();
      },
      cleanup: async () => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  // Postgres: carve out a private schema per test file so files don't collide.
  // The CI workflow provides DATABASE_URL pointing at a real Postgres; we
  // append `?schema=<random>` so the migrations land in an isolated namespace.
  const base = process.env.DATABASE_URL!;
  const schemaName = `t_${randomBytes(8).toString("hex")}`;
  const u = new URL(base);
  u.searchParams.set("schema", schemaName);
  const dbUrl = u.toString();

  // We need a one-shot connection on the BASE url to CREATE SCHEMA, then the
  // returned dbUrl is what tests actually use.
  const admin = new PrismaClient({ datasourceUrl: base });
  await admin.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  await admin.$disconnect();

  return {
    dbUrl,
    engine,
    applyMigration: (p) => applyMigration(p, "postgresql"),
    truncateAll: async (p) => {
      // TRUNCATE ... CASCADE is faster than per-row deleteMany on PG and
      // resets the SERIAL sequence on Event.id, which keeps per-test
      // assertions about event ids stable.
      await p.$executeRawUnsafe(
        `TRUNCATE TABLE "events", "participants", "sessions", "agents" RESTART IDENTITY CASCADE`,
      );
    },
    cleanup: async () => {
      const cleanupAdmin = new PrismaClient({ datasourceUrl: base });
      await cleanupAdmin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await cleanupAdmin.$disconnect();
    },
  };
}
