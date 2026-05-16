// Verifies REGISTER_RATE_LIMIT=0 disables the per-IP registration limiter.
//
// Separate file from register.e2e.test.ts because the rate limiter + config
// are module singletons evaluated at import time — a fresh Vitest file gives
// us a clean module registry to re-evaluate them with the limiter off.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";
  process.env.REGISTER_RATE_LIMIT = "0"; // disabled

  delete (globalThis as { prisma?: PrismaClient }).prisma;
  ({ default: prisma } = await import("../../db.js"));
  await testDb.applyMigration(prisma);
  const { buildApp } = await import("../app.js");
  app = buildApp();
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
          headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
        }),
      );
      expect(res.status).toBe(201);
    }
  });
});
