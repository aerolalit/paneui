// End-to-end tests for the /v1/taste routes — per-agent freeform "taste
// notes" markdown attachment. Covers auth, GET-when-null, PUT round-trip, empty
// rejection, oversize → 413, DELETE clears, and PUT-replaces-not-appends.

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

const TASTE_CAP = 256; // small cap for the oversize test

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
      MAX_TASTE_BYTES: String(TASTE_CAP),
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

function bearer(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function req(
  method: string,
  apiKey: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = apiKey
    ? bearer(apiKey)
    : { "content-type": "application/json" };
  return app.fetch(
    new Request("http://t/v1/taste", {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

describe("/v1/taste", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await req("GET", null);
    expect(res.status).toBe(401);
  });

  it("GET returns null taste/updated_at and 0 bytes when never written", async () => {
    const apiKey = await seedAgent();
    const res = await req("GET", apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taste: string | null;
      updated_at: string | null;
      bytes: number;
    };
    expect(body).toEqual({ taste: null, updated_at: null, bytes: 0 });
  });

  it("PUT then GET round-trips the attachment with the correct utf8 byte count", async () => {
    const apiKey = await seedAgent();
    const attachment = "- denser layout\n- no rounded corners\n- emoji ✨";
    const put = await req("PUT", apiKey, { taste: attachment });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as {
      taste: string;
      updated_at: string;
      bytes: number;
    };
    expect(putBody.taste).toBe(attachment);
    expect(putBody.bytes).toBe(Buffer.byteLength(attachment, "utf8"));
    expect(putBody.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const get = await req("GET", apiKey);
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { taste: string; bytes: number };
    expect(getBody.taste).toBe(attachment);
    expect(getBody.bytes).toBe(Buffer.byteLength(attachment, "utf8"));
  });

  it("rejects an empty PUT with 400 invalid_request and a clear hint", async () => {
    const apiKey = await seedAgent();
    const res = await req("PUT", apiKey, { taste: "   \n\t  " });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; hint?: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.hint).toMatch(/DELETE/);
  });

  it("rejects oversize PUT (> MAX_TASTE_BYTES) with 413", async () => {
    const apiKey = await seedAgent();
    const attachment = "x".repeat(TASTE_CAP + 1);
    const res = await req("PUT", apiKey, { taste: attachment });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  it("DELETE clears the attachment (subsequent GET sees null)", async () => {
    const apiKey = await seedAgent();
    await req("PUT", apiKey, { taste: "some notes" });
    const del = await req("DELETE", apiKey);
    expect(del.status).toBe(204);
    const get = await req("GET", apiKey);
    const body = (await get.json()) as {
      taste: string | null;
      updated_at: string | null;
      bytes: number;
    };
    expect(body).toEqual({ taste: null, updated_at: null, bytes: 0 });
  });

  it("PUT REPLACES the attachment (does not append to the previous value)", async () => {
    const apiKey = await seedAgent();
    await req("PUT", apiKey, { taste: "first" });
    const second = await req("PUT", apiKey, { taste: "second" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { taste: string };
    expect(body.taste).toBe("second");

    const get = await req("GET", apiKey);
    const getBody = (await get.json()) as { taste: string };
    expect(getBody.taste).toBe("second");
  });
});
