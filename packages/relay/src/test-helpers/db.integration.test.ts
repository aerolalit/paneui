// Integration test for the test-harness's own migration loader.
//
// Pins the contract that closes issue #118: applying migrations against a
// fresh DB must be safe, and applying them a second time against the same
// DB must be a no-op (not a throw). Both flows previously broke on the
// SQLite job:
//
//   - First-apply break (the actual root cause, found via diagnostic
//     logging on PR #130): Prisma's query engine maintains a connection
//     pool per PrismaClient, and `$executeRawUnsafe` is free to grab any
//     connection. With per-connection SQLite snapshots (WAL mode), the
//     third migration's RedefineTables sequence — CREATE new_x, INSERT
//     FROM x, DROP x, RENAME new_x → x, CREATE INDEX … ON x — can
//     interleave across connections so that CREATE INDEX runs on a
//     connection that hasn't yet observed the RENAME and errors with
//     `no such table: main.artifact_versions`.
//   - Second-apply break: the original DROP INDEX / CREATE statements in
//     later migrations error on a re-applied database.
//
// The fix wraps every statement in a single Prisma interactive
// transaction (pinned connection) and gates the whole loop behind a
// sentinel-table probe; both behaviours are exercised below.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPrismaClient } from "../db.js";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "./db.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  prisma = createPrismaClient(testDb.dbUrl);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

describe("applyMigration (issue #118)", () => {
  it("applies migrations against a fresh database without errors", async () => {
    // First-apply path — this is what produced
    // `no such table: main.artifact_versions` on the sqlite job before
    // the fix. With the transaction-pinned connection, every step of
    // the RedefineTables sequence is observed atomically.
    await expect(testDb.applyMigration(prisma)).resolves.toBeUndefined();

    // Sanity: schema is usable end-to-end. Use the Prisma client model
    // API so the assertion is portable across sqlite and postgres.
    await expect(prisma.artifactVersion.count()).resolves.toBe(0);
  });

  it("is a no-op on a second call against the same database", async () => {
    // Re-entry must not throw, regardless of what the underlying
    // migration files do (DROP INDEX, ALTER TABLE ADD COLUMN, etc.).
    // The sentinel-table guard short-circuits the loop; this test would
    // fail if a regression removed it.
    await expect(testDb.applyMigration(prisma)).resolves.toBeUndefined();
    await expect(testDb.applyMigration(prisma)).resolves.toBeUndefined();

    // And the schema is still intact afterwards.
    await expect(prisma.artifactVersion.count()).resolves.toBe(0);
  });
});
