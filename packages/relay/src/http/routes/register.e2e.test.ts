// End-to-end tests for POST /v1/register: open registration + per-IP rate
// limiting. Drives requests through the real Hono app.
//
// The rate limiter and config are module singletons evaluated at import time,
// so REGISTER_RATE_* env vars are set before the dynamic import below. The
// disabled-limiter (REGISTER_RATE_LIMIT=0) case lives in its own test file
// because each Vitest file gets a fresh module registry.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
  // Small limit so the rate-limit case is cheap and deterministic.
  process.env.REGISTER_RATE_LIMIT = "3";
  process.env.REGISTER_RATE_WINDOW_SECONDS = "3600";

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

/** POST /v1/register from a given client IP (via x-forwarded-for). */
function register(ip: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.fetch(new Request("http://t/v1/register", init));
}

describe("POST /v1/register (open registration)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("mints a key with no body at all (201)", async () => {
    const res = await register("10.0.0.1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string; api_key: string; key_prefix: string };
    expect(body.agent_id).toBeTruthy();
    expect(body.api_key).toMatch(/^pane_/);
    expect(body.api_key.startsWith(body.key_prefix)).toBe(true);
  });

  it("accepts an optional name", async () => {
    const res = await register("10.0.0.2", { name: "ci-bot" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    const agent = await prisma.agent.findUnique({ where: { id: body.agent_id } });
    expect(agent?.name).toBe("ci-bot");
  });

  it("rejects a malformed name (400)", async () => {
    const res = await register("10.0.0.3", { name: "x".repeat(65) });
    expect(res.status).toBe(400);
  });

  it("rate-limits the same IP after the configured limit (429)", async () => {
    // limit is 3 — the 4th request from one IP must be rejected.
    for (let i = 0; i < 3; i++) {
      expect((await register("10.1.1.1")).status).toBe(201);
    }
    const over = await register("10.1.1.1");
    expect(over.status).toBe(429);
    const body = (await over.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("rate-limits each IP independently", async () => {
    for (let i = 0; i < 3; i++) await register("10.2.2.2");
    expect((await register("10.2.2.2")).status).toBe(429);
    // A different IP is unaffected.
    expect((await register("10.3.3.3")).status).toBe(201);
  });
});
