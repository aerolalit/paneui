// Integration test for the test-harness's own migration loader.
//
// Issue #118: the e2e job intermittently failed inside `applyMigration` with
// "there is already another table or index with this name: artifact_versions"
// (sqlite) or the Postgres equivalent. The trigger is `applyMigration` being
// re-entered against the same database — once it's re-applied, the third
// migration's RedefineTables pattern (CREATE new_x → INSERT FROM x → DROP x
// → RENAME → CREATE INDEX) collides with itself in any of several ways.
//
// This test pins the contract that fixes the flake: calling `applyMigration`
// twice on the same DB is a no-op the second time, not a throw. Failure here
// is a regression to the sentinel guard in db.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPrismaClient } from "../db.js";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "./db.js";

let testDb: TestDb;
let prisma: PrismaClient;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  testDb = await setupTestDb();
  ({ prisma, close: closeDb } = createPrismaClient(testDb.dbUrl));
});

afterAll(async () => {
  await closeDb();
  await testDb.cleanup();
});

describe("applyMigration re-entry (issue #118)", () => {
  it("is a no-op on the second call against the same database", async () => {
    // First call: normal path — applies all migration files end to end.
    await testDb.applyMigration(prisma);

    // Second call: must not throw. Without the sentinel-table guard this
    // throws "already another table or index with this name" (sqlite) or
    // "relation … already exists" (postgres) during the per-statement loop.
    await expect(testDb.applyMigration(prisma)).resolves.toBeUndefined();

    // And a third for good measure — proves the guard is stable, not a
    // one-shot path.
    await expect(testDb.applyMigration(prisma)).resolves.toBeUndefined();

    // Sanity: schema is still usable end-to-end after the re-applies. If the
    // RedefineTables migration had been re-entered destructively, querying
    // `artifact_versions` would throw "no such table".
    const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
      'SELECT COUNT(*) AS n FROM "artifact_versions"',
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
