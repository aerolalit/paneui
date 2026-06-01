// End-to-end test for the per-agent pane cap (abuse control B3).
//
// MAX_PANES_PER_AGENT is supplied via the config injected into buildApp(),
// so the small cap is just passed straight to loadConfig() — no
// module-singleton juggling required.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { hashKey, keyPrefix } from "../../keys.js";
import { buildApp } from "../app.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

const CAP = 3;

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
      MAX_PANES_PER_AGENT: String(CAP),
    }),
    prisma,
  );
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

function createPane(apiKey: string): Promise<Response> {
  return app.fetch(
    new Request("http://t/v1/panes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        template: {
          type: "html-inline",
          source: "<html></html>",
          event_schema: minimalSchema,
        },
        title: "Test pane",
      }),
    }),
  );
}

describe("per-agent pane cap", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects pane creation past MAX_PANES_PER_AGENT with 429", async () => {
    const apiKey = await seedAgent();
    for (let i = 0; i < CAP; i++) {
      expect((await createPane(apiKey)).status).toBe(201);
    }
    const over = await createPane(apiKey);
    expect(over.status).toBe(429);
    const body = (await over.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("closing a pane frees a slot", async () => {
    const apiKey = await seedAgent();
    const ids: string[] = [];
    for (let i = 0; i < CAP; i++) {
      const res = await createPane(apiKey);
      ids.push(((await res.json()) as { pane_id: string }).pane_id);
    }
    expect((await createPane(apiKey)).status).toBe(429);

    // Close one — its slot is reclaimed (only `open` panes count).
    const del = await app.fetch(
      new Request(`http://t/v1/panes/${ids[0]}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(del.status).toBe(204);
    expect((await createPane(apiKey)).status).toBe(201);
  });

  it("the cap is per-agent — a second agent is unaffected", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    for (let i = 0; i < CAP; i++) await createPane(a);
    expect((await createPane(a)).status).toBe(429);
    expect((await createPane(b)).status).toBe(201);
  });
});
