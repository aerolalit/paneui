// End-to-end tests for /v1/feedback — POST creates a row, GET lists the
// caller's own rows with cursor pagination, and surface_id ownership is
// enforced. Validation errors and auth are covered against the same surface.

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
    }),
    prisma,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: agent.id, apiKey };
}

async function seedSession(agentId: string): Promise<string> {
  const template = await prisma.template.create({
    data: { ownerId: agentId },
  });
  const av = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>x</p>",
    },
  });
  const surface = await prisma.surface.create({
    data: {
      id: "sess_" + randomBytes(8).toString("hex"),
      agentId,
      templateVersionId: av.id,
      title: "Test surface",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return surface.id;
}

function bearer(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function req(
  method: string,
  path: string,
  apiKey: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = apiKey
    ? bearer(apiKey)
    : { "content-type": "application/json" };
  return app.fetch(
    new Request("http://t" + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

describe("/v1/feedback", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects unauthenticated POST with 401", async () => {
    const res = await req("POST", "/v1/feedback", null, {
      type: "bug",
      message: "x",
    });
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated GET with 401", async () => {
    const res = await req("GET", "/v1/feedback", null);
    expect(res.status).toBe(401);
  });

  it("POST creates a row and returns only id/type/created_at (no message echo)", async () => {
    const { apiKey } = await seedAgent();
    const res = await req("POST", "/v1/feedback", apiKey, {
      type: "bug",
      message: "watch hangs on empty surface",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.any(String),
      type: "bug",
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(body["message"]).toBeUndefined();
  });

  it("rejects an unknown type with 400", async () => {
    const { apiKey } = await seedAgent();
    const res = await req("POST", "/v1/feedback", apiKey, {
      type: "praise",
      message: "you are great",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects an empty/whitespace message with 400 (after trim)", async () => {
    const { apiKey } = await seedAgent();
    const res = await req("POST", "/v1/feedback", apiKey, {
      type: "note",
      message: "   \n\t  ",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a message > 4000 chars with 400", async () => {
    const { apiKey } = await seedAgent();
    const res = await req("POST", "/v1/feedback", apiKey, {
      type: "note",
      message: "x".repeat(4001),
    });
    expect(res.status).toBe(400);
  });

  it("accepts an optional surface_id owned by the caller", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const surfaceId = await seedSession(agentId);
    const res = await req("POST", "/v1/feedback", apiKey, {
      type: "feature",
      message: "richer event types",
      surface_id: surfaceId,
    });
    expect(res.status).toBe(201);
    const stored = await prisma.feedback.findFirst({ where: { agentId } });
    expect(stored?.surfaceId).toBe(surfaceId);
  });

  it("returns 404 when surface_id is not owned by the caller", async () => {
    const { apiKey } = await seedAgent();
    const other = await seedAgent();
    const otherSession = await seedSession(other.id);
    const res = await req("POST", "/v1/feedback", apiKey, {
      type: "bug",
      message: "spoofy",
      surface_id: otherSession,
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when surface_id does not exist", async () => {
    const { apiKey } = await seedAgent();
    const res = await req("POST", "/v1/feedback", apiKey, {
      type: "bug",
      message: "ghost",
      surface_id: "sess_does_not_exist",
    });
    expect(res.status).toBe(404);
  });

  it("GET returns ONLY the caller's own submissions", async () => {
    const me = await seedAgent();
    const other = await seedAgent();
    await req("POST", "/v1/feedback", me.apiKey, {
      type: "bug",
      message: "mine 1",
    });
    await req("POST", "/v1/feedback", me.apiKey, {
      type: "note",
      message: "mine 2",
    });
    await req("POST", "/v1/feedback", other.apiKey, {
      type: "bug",
      message: "theirs",
    });

    const res = await req("GET", "/v1/feedback", me.apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { message: string }[];
      next_before?: string;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.message).sort()).toEqual([
      "mine 1",
      "mine 2",
    ]);
    expect(body.next_before).toBeUndefined();
  });

  it("GET paginates with ?limit and ?before", async () => {
    const { apiKey } = await seedAgent();
    for (let i = 0; i < 5; i++) {
      const res = await req("POST", "/v1/feedback", apiKey, {
        type: "note",
        message: `m${i}`,
      });
      expect(res.status).toBe(201);
      // Force distinct createdAt timestamps so the cursor is well-ordered.
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1Res = await req("GET", "/v1/feedback?limit=2", apiKey);
    const page1 = (await page1Res.json()) as {
      items: { message: string; created_at: string }[];
      next_before?: string;
    };
    expect(page1.items).toHaveLength(2);
    expect(page1.items.map((i) => i.message)).toEqual(["m4", "m3"]);
    expect(page1.next_before).toBeDefined();

    const page2Res = await req(
      "GET",
      `/v1/feedback?limit=2&before=${encodeURIComponent(page1.next_before!)}`,
      apiKey,
    );
    const page2 = (await page2Res.json()) as {
      items: { message: string }[];
      next_before?: string;
    };
    expect(page2.items).toHaveLength(2);
    expect(page2.items.map((i) => i.message)).toEqual(["m2", "m1"]);
    expect(page2.next_before).toBeDefined();

    const page3Res = await req(
      "GET",
      `/v1/feedback?limit=2&before=${encodeURIComponent(page2.next_before!)}`,
      apiKey,
    );
    const page3 = (await page3Res.json()) as {
      items: { message: string }[];
      next_before?: string;
    };
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]!.message).toBe("m0");
    expect(page3.next_before).toBeUndefined();
  });

  it("rejects ?limit > 100 with 400", async () => {
    const { apiKey } = await seedAgent();
    const res = await req("GET", "/v1/feedback?limit=101", apiKey);
    expect(res.status).toBe(400);
  });

  it("rejects a non-ISO ?before cursor with 400", async () => {
    const { apiKey } = await seedAgent();
    const res = await req("GET", "/v1/feedback?before=not-a-date", apiKey);
    expect(res.status).toBe(400);
  });
});
