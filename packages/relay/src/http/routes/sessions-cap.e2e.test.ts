// End-to-end test for the per-agent session cap (abuse control B3).
//
// MAX_SESSIONS_PER_AGENT is read from a config module singleton evaluated at
// import time, so it is set in beforeAll before the dynamic imports. A
// dedicated test file gives a clean module registry to evaluate it with.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;
let hashKey: typeof import("../../keys.js").hashKey;
let keyPrefix: typeof import("../../keys.js").keyPrefix;

const CAP = 3;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";
  process.env.MAX_SESSIONS_PER_AGENT = String(CAP);

  delete (globalThis as { prisma?: PrismaClient }).prisma;
  ({ default: prisma } = await import("../../db.js"));
  await testDb.applyMigration(prisma);
  ({ hashKey, keyPrefix } = await import("../../keys.js"));
  const { buildApp } = await import("../app.js");
  app = buildApp();
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedAgent(): Promise<string> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return apiKey;
}

const minimalSchema = {
  events: {
    ping: { payload: { type: "object" }, emittedBy: ["page", "agent"] },
  },
};

function createSession(apiKey: string): Promise<Response> {
  return app.fetch(
    new Request("http://t/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        artifact: { type: "html-inline", source: "<html></html>" },
        schema: minimalSchema,
      }),
    }),
  );
}

describe("per-agent session cap", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects session creation past MAX_SESSIONS_PER_AGENT with 429", async () => {
    const apiKey = await seedAgent();
    for (let i = 0; i < CAP; i++) {
      expect((await createSession(apiKey)).status).toBe(201);
    }
    const over = await createSession(apiKey);
    expect(over.status).toBe(429);
    const body = (await over.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("closing a session frees a slot", async () => {
    const apiKey = await seedAgent();
    const ids: string[] = [];
    for (let i = 0; i < CAP; i++) {
      const res = await createSession(apiKey);
      ids.push(((await res.json()) as { session_id: string }).session_id);
    }
    expect((await createSession(apiKey)).status).toBe(429);

    // Close one — its slot is reclaimed (only `open` sessions count).
    const del = await app.fetch(
      new Request(`http://t/v1/sessions/${ids[0]}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(del.status).toBe(204);
    expect((await createSession(apiKey)).status).toBe(201);
  });

  it("the cap is per-agent — a second agent is unaffected", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    for (let i = 0; i < CAP; i++) await createSession(a);
    expect((await createSession(a)).status).toBe(429);
    expect((await createSession(b)).status).toBe(201);
  });
});
