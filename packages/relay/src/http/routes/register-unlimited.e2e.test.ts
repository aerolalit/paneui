// Verifies REGISTER_RATE_LIMIT=0 disables the per-IP registration limiter.
//
// With config injected via buildApp(), the disabled-limiter config is just
// passed straight to loadConfig() — no module-singleton juggling required.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(
    loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
      REGISTER_RATE_LIMIT: "0", // disabled
    }),
    prisma,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

describe("POST /v1/register with REGISTER_RATE_LIMIT=0", () => {
  it("never rate-limits, even with many requests from one IP", async () => {
    await testDb.truncateAll(prisma);
    for (let i = 0; i < 8; i++) {
      const res = await app.fetch(
        new Request("http://t/v1/register", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "10.9.9.9",
          },
        }),
      );
      expect(res.status).toBe(201);
    }
  });
});
