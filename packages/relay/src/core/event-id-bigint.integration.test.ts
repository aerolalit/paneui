// Postgres-only schema test: asserts the `events.id` column is BIGINT (int8),
// not the int4 a plain SERIAL would produce.
//
// Why this exists: a SERIAL column tops out at 2.1B rows. Migration
// 20260518090000_event_id_bigint widens it to BIGINT for hosted-scale
// headroom. The Prisma model deliberately keeps `Event.id` as `Int` so the
// generated client type stays `number` on both engines (see
// prisma/schema.postgres.prisma) — which means a regression to int4 would NOT
// be caught by typegen or the e2e suite. This test is the guard.
//
// On sqlite the column type is rowid-aliased INTEGER regardless, so the
// assertion is meaningless there and the test self-skips.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";

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
  if (prisma) await prisma.$disconnect();
  if (testDb) await testDb.cleanup();
});

describe("events.id column width", () => {
  it("is BIGINT on Postgres (headroom past int4's 2.1B limit)", async ({
    skip,
  }) => {
    if (testDb.engine !== "postgresql") {
      skip();
      return;
    }

    // Scope to current_schema(): setupTestDb gives each test file its own
    // Postgres schema, and information_schema.columns spans all of them — an
    // unscoped query would match every parallel test file's `events` table.
    const rows = await prisma.$queryRawUnsafe<{ data_type: string }[]>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'events' AND column_name = 'id'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe("bigint");
  });

  it("the events.id sequence is also bigint (inserts past 2.1B must not overflow)", async ({
    skip,
  }) => {
    if (testDb.engine !== "postgresql") {
      skip();
      return;
    }

    // Widening the column alone is not enough: the SERIAL-owned sequence keeps
    // its int4 MAXVALUE (2147483647) and would overflow at exactly the ceiling
    // this migration removes. pg_sequences reports the live type + max_value.
    // data_type is a `regtype` — cast to text so Prisma can deserialize it.
    const rows = await prisma.$queryRawUnsafe<
      { data_type: string; max_value: bigint }[]
    >(
      `SELECT data_type::text AS data_type, max_value FROM pg_sequences
       WHERE schemaname = current_schema() AND sequencename = 'events_id_seq'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe("bigint");
    // int4 max is 2147483647; a widened sequence sits far past it.
    expect(BigInt(rows[0]!.max_value)).toBeGreaterThan(2147483647n);
  });
});
