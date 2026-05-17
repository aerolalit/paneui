// End-to-end tests for POST /v1/register: open registration + per-IP rate
// limiting. Drives requests through the real Hono app.
//
// The rate limiter is built by buildApp() from the injected config, so the
// REGISTER_RATE_* env vars just need to be set before loadConfig() runs. The
// disabled-limiter (REGISTER_RATE_LIMIT=0) case lives in its own test file so
// it can build a second app with a different config.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";
  // Small limit so the rate-limit case is cheap and deterministic.
  process.env.REGISTER_RATE_LIMIT = "3";
  process.env.REGISTER_RATE_WINDOW_SECONDS = "3600";
  // Treat the simulated socket peer (127.0.0.1, see register()) as a trusted
  // proxy so the X-Forwarded-For header is honored and each test IP gets its
  // own rate-limit bucket.
  process.env.TRUSTED_PROXY = "127.0.0.1";

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  // loadConfig() reads the REGISTER_RATE_* env vars set just above.
  app = buildApp(loadConfig(), prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

/**
 * POST /v1/register from a given client IP. The IP is presented via
 * `x-forwarded-for`; the simulated socket peer is 127.0.0.1, which the test
 * config marks as a TRUSTED_PROXY so the XFF value is honored.
 */
function register(ip: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  // The second arg becomes Hono's `c.env`; getConnInfo reads the socket peer
  // off `env.incoming.socket.remoteAddress`.
  return app.fetch(new Request("http://t/v1/register", init), {
    incoming: { socket: { remoteAddress: "127.0.0.1" } },
  });
}

describe("POST /v1/register (open registration)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("mints a key with no body at all (201)", async () => {
    const res = await register("10.0.0.1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent_id: string;
      api_key: string;
      key_prefix: string;
    };
    expect(body.agent_id).toBeTruthy();
    expect(body.api_key).toMatch(/^pane_/);
    expect(body.api_key.startsWith(body.key_prefix)).toBe(true);
  });

  it("accepts an optional name", async () => {
    const res = await register("10.0.0.2", { name: "ci-bot" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    const agent = await prisma.agent.findUnique({
      where: { id: body.agent_id },
    });
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
    const body = (await over.json()) as {
      error: {
        code: string;
        hint?: string;
        retryable?: boolean;
        docs_url?: string;
      };
    };
    expect(body.error.code).toBe("rate_limited");
    // A 429 is the one retryable error class — an agent should back off + retry.
    expect(body.error.retryable).toBe(true);
    expect(body.error.hint).toMatch(/wait|retry/i);
    expect(body.error.docs_url).toContain("docs/SPEC.md#");
  });

  it("rate-limits each IP independently", async () => {
    for (let i = 0; i < 3; i++) await register("10.2.2.2");
    expect((await register("10.2.2.2")).status).toBe(429);
    // A different IP is unaffected.
    expect((await register("10.3.3.3")).status).toBe(201);
  });
});
