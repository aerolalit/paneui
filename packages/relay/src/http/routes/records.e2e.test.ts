// E2E tests for /v1/panes/:id/records/:collection (#292).
//
// The deep writer semantics live in core/records.test.ts (31 unit tests).
// These tests cover the route layer: auth, body parsing, query-param
// decoding, status codes, response envelopes.

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

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const recordSchema = {
  $defs: {
    Comment: {
      type: "object",
      properties: { body: { type: "string", minLength: 1 } },
      required: ["body"],
    },
  },
  "x-pane-collections": {
    comments: {
      schema: { $ref: "#/$defs/Comment" },
      write: ["page", "agent"],
      delete: ["agent", "author"],
    },
  },
};

async function seedAgent(): Promise<{ apiKey: string; agentId: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { apiKey, agentId: agent.id };
}

async function seedPaneWithRecords(agentId: string): Promise<string> {
  const template = await prisma.template.create({
    data: { ownerId: agentId, name: "Records Test", latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      recordSchema,
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: `pan_${randomBytes(8).toString("hex")}`,
      agentId,
      templateVersionId: version.id,
      title: "records routes e2e pane",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return pane.id;
}

function agentBearer(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function req(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: agentBearer(apiKey),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

// ---------------------------------------------------------------------------
// POST /
// ---------------------------------------------------------------------------

describe("POST /v1/panes/:id/records/:collection", () => {
  it("creates a record and returns 201 with the persisted row", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "POST",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
      { record_key: "cmt_1", data: { body: "hi" } },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { record: { key: string } };
    expect(body.record.key).toBe("cmt_1");
  });

  it("returns 200 + deduped:true on duplicate record_key", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    await req("POST", `/v1/panes/${paneId}/records/comments`, apiKey, {
      record_key: "cmt_dup",
      data: { body: "v1" },
    });
    const res = await req(
      "POST",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
      { record_key: "cmt_dup", data: { body: "v2-ignored" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deduped: boolean };
    expect(body.deduped).toBe(true);
  });

  it("rejects invalid body with 400 invalid_request", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "POST",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
      { record_key: 42 }, // wrong type — should be string
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects schema-violating data with 422 record_schema_violation", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "POST",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
      { data: { wrong: "no body" } },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("record_schema_violation");
  });

  it("returns 404 with record_collection_not_found on undeclared collection", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "POST",
      `/v1/panes/${paneId}/records/unknown`,
      apiKey,
      { data: { body: "x" } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("record_collection_not_found");
  });

  it("rejects unauthenticated request with 401", async () => {
    const { agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/records/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { body: "x" } }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an agent that doesn't own the pane with 403/404", async () => {
    const owner = await seedAgent();
    const intruder = await seedAgent();
    const paneId = await seedPaneWithRecords(owner.agentId);
    const res = await req(
      "POST",
      `/v1/panes/${paneId}/records/comments`,
      intruder.apiKey,
      { data: { body: "x" } },
    );
    // dualAuth rejects with 403 forbidden or 404 session_not_found
    // depending on which lookup loses — both are acceptable rejections.
    expect([401, 403, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

describe("GET /v1/panes/:id/records/:collection", () => {
  it("returns an empty page for an unwritten collection", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "GET",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: unknown[];
      has_more: boolean;
    };
    expect(body.records).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it("paginates with ?since= and ?limit=", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    for (let i = 0; i < 5; i++) {
      await req("POST", `/v1/panes/${paneId}/records/comments`, apiKey, {
        record_key: `c_${i}`,
        data: { body: String(i) },
      });
    }
    const res = await req(
      "GET",
      `/v1/panes/${paneId}/records/comments?since=0&limit=2`,
      apiKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: { key: string }[];
      next_since: number;
      has_more: boolean;
    };
    expect(body.records.map((r) => r.key)).toEqual(["c_0", "c_1"]);
    expect(body.has_more).toBe(true);

    const res2 = await req(
      "GET",
      `/v1/panes/${paneId}/records/comments?since=${body.next_since}&limit=10`,
      apiKey,
    );
    const body2 = (await res2.json()) as { records: { key: string }[] };
    expect(body2.records.map((r) => r.key)).toEqual(["c_2", "c_3", "c_4"]);
  });

  it("rejects invalid ?since with 400", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "GET",
      `/v1/panes/${paneId}/records/comments?since=-1`,
      apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("rejects ?limit over 200 with 400", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "GET",
      `/v1/panes/${paneId}/records/comments?limit=999`,
      apiKey,
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /:recordKey
// ---------------------------------------------------------------------------

describe("PATCH /v1/panes/:id/records/:collection/:recordKey", () => {
  it("updates a record and returns 200 with the new version", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    await req("POST", `/v1/panes/${paneId}/records/comments`, apiKey, {
      record_key: "cmt_u",
      data: { body: "v1" },
    });
    const res = await req(
      "PATCH",
      `/v1/panes/${paneId}/records/comments/cmt_u`,
      apiKey,
      { data: { body: "v2" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: { version: number } };
    expect(body.record.version).toBe(2);
  });

  it("returns 409 with details.current on if_match mismatch", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    await req("POST", `/v1/panes/${paneId}/records/comments`, apiKey, {
      record_key: "cmt_l",
      data: { body: "v1" },
    });
    const res = await req(
      "PATCH",
      `/v1/panes/${paneId}/records/comments/cmt_l`,
      apiKey,
      { data: { body: "v2" }, if_match: 99 },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: {
        code: string;
        details: { current: { version: number; data: unknown } };
      };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details.current.version).toBe(1);
    expect(body.error.details.current.data).toEqual({ body: "v1" });
  });

  it("returns 404 when the record does not exist", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "PATCH",
      `/v1/panes/${paneId}/records/comments/never_created`,
      apiKey,
      { data: { body: "x" } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("record_not_found");
  });
});

// ---------------------------------------------------------------------------
// DELETE /:recordKey
// ---------------------------------------------------------------------------

describe("DELETE /v1/panes/:id/records/:collection/:recordKey", () => {
  it("soft-deletes a record and returns 204", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    await req("POST", `/v1/panes/${paneId}/records/comments`, apiKey, {
      record_key: "cmt_d",
      data: { body: "to delete" },
    });
    const res = await req(
      "DELETE",
      `/v1/panes/${paneId}/records/comments/cmt_d`,
      apiKey,
    );
    expect(res.status).toBe(204);

    // Tombstone is visible via GET.
    const getRes = await req(
      "GET",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
    );
    const body = (await getRes.json()) as {
      records: { key: string; deleted_at: string | null }[];
    };
    const found = body.records.find((r) => r.key === "cmt_d");
    expect(found?.deleted_at).not.toBeNull();
  });

  it("returns 409 with details.current on if_match mismatch", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    await req("POST", `/v1/panes/${paneId}/records/comments`, apiKey, {
      record_key: "cmt_dl",
      data: { body: "v1" },
    });
    const res = await req(
      "DELETE",
      `/v1/panes/${paneId}/records/comments/cmt_dl`,
      apiKey,
      { if_match: 99 },
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 on already-deleted record", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    await req("POST", `/v1/panes/${paneId}/records/comments`, apiKey, {
      record_key: "cmt_g",
      data: { body: "v1" },
    });
    await req("DELETE", `/v1/panes/${paneId}/records/comments/cmt_g`, apiKey);
    const res = await req(
      "DELETE",
      `/v1/panes/${paneId}/records/comments/cmt_g`,
      apiKey,
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Unrouted verb / path fallback handlers.
//
// Before the fallback handlers were added, PUT/GET/HEAD on the records
// sub-paths returned 401 — the request used a verb the records subrouter
// didn't handle, bubbled out, and hit participants-human's wildcard
// cookie-auth middleware (mounted at `/v1/panes` with `use("*", requireHuman)`)
// which 401'd on the missing cookie. The fallbacks intercept first.
// ---------------------------------------------------------------------------

describe("records router fallback handlers", () => {
  it("PUT on /:recordKey returns 405 with Allow: PATCH, DELETE", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "PUT",
      `/v1/panes/${paneId}/records/todos/some-key`,
      apiKey,
      { data: { x: 1 } },
    );
    expect(res.status).toBe(405);
    const allow = res.headers.get("allow") ?? "";
    expect(allow).toContain("PATCH");
    expect(allow).toContain("DELETE");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });

  it("HEAD on /:recordKey returns 405", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "HEAD",
      `/v1/panes/${paneId}/records/todos/some-key`,
      apiKey,
    );
    expect(res.status).toBe(405);
  });

  it("PUT on / returns 405 with Allow: GET, POST", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req("PUT", `/v1/panes/${paneId}/records/todos`, apiKey, {
      data: { x: 1 },
    });
    expect(res.status).toBe(405);
    const allow = res.headers.get("allow") ?? "";
    expect(allow).toContain("GET");
    expect(allow).toContain("POST");
  });

  it("paths deeper than /:recordKey return 404", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await req(
      "PATCH",
      `/v1/panes/${paneId}/records/todos/key/extra/segments`,
      apiKey,
      { data: { x: 1 } },
    );
    expect(res.status).toBe(404);
  });

  it("regression: POST with no auth still returns 401, not 405", async () => {
    const { agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/records/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { title: "x", done: false } }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// F-08 — a soft-deleted (trashed) pane must refuse record reads + writes
// through dualAuth. Trashing sets deletedAt but keeps status="open" + a
// future expiresAt, so the status/expiry gate alone does NOT catch it; the
// dualAuth deletedAt check does. A non-deleted pane keeps working (covered by
// the happy-path tests above; re-asserted here for the before/after contrast).
// ---------------------------------------------------------------------------

describe("F-08: trashed pane refuses records via dualAuth", () => {
  it("rejects a record WRITE on a soft-deleted pane with 410 soft_deleted", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    await prisma.pane.update({
      where: { id: paneId },
      data: { deletedAt: new Date() },
    });
    // Sanity: still open + unexpired — only deletedAt flipped.
    const row = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(row?.status).toBe("open");
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const res = await req(
      "POST",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
      { data: { body: "hi" } },
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("soft_deleted");
  });

  it("rejects a record READ on a soft-deleted pane with 410 soft_deleted", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    // Write one record while the pane is live, then trash it.
    await req("POST", `/v1/panes/${paneId}/records/comments`, apiKey, {
      record_key: "c1",
      data: { body: "live" },
    });
    await prisma.pane.update({
      where: { id: paneId },
      data: { deletedAt: new Date() },
    });

    const res = await req(
      "GET",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("soft_deleted");
  });

  it("a non-deleted pane still reads + writes records normally", async () => {
    const { apiKey, agentId } = await seedAgent();
    const paneId = await seedPaneWithRecords(agentId);
    const write = await req(
      "POST",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
      { record_key: "ok1", data: { body: "still works" } },
    );
    expect(write.status).toBe(201);
    const read = await req(
      "GET",
      `/v1/panes/${paneId}/records/comments`,
      apiKey,
    );
    expect(read.status).toBe(200);
    const body = (await read.json()) as { records: { key: string }[] };
    expect(body.records.map((r) => r.key)).toContain("ok1");
  });
});
