// E2E tests for /v1/templates/:id/template-records/:collection.
//
// Owner-only routes: requireAgent + agent-scope ownership check. Mirrors
// the per-pane records e2e suite verb-for-verb, with the additional
// "non-owner agent is rejected" check that owner-only routes need.

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

const templateRecordSchema = {
  $defs: {
    Question: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1 },
        weight: { type: "number" },
      },
      required: ["text"],
    },
  },
  "x-pane-collections": {
    questions: {
      schema: { $ref: "#/$defs/Question" },
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

async function seedTemplateWithRecords(agentId: string): Promise<string> {
  const template = await prisma.template.create({
    data: { ownerId: agentId, latestVersion: 1, name: "Test Template" },
  });
  await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      templateRecordSchema,
    },
  });
  return template.id;
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

describe("POST /v1/templates/:id/template-records/:collection", () => {
  it("creates a template record and returns 201", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    const res = await req(
      "POST",
      `/v1/templates/${templateId}/template-records/questions`,
      apiKey,
      { record_key: "q1", data: { text: "What is Pane?" } },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      record: { key: string; data: { text: string } };
    };
    expect(body.record.key).toBe("q1");
    expect(body.record.data.text).toBe("What is Pane?");
  });

  it("returns 200 + deduped:true on duplicate record_key", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    await req(
      "POST",
      `/v1/templates/${templateId}/template-records/questions`,
      apiKey,
      { record_key: "q_dup", data: { text: "v1" } },
    );
    const res = await req(
      "POST",
      `/v1/templates/${templateId}/template-records/questions`,
      apiKey,
      { record_key: "q_dup", data: { text: "v2-ignored" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deduped: boolean };
    expect(body.deduped).toBe(true);
  });

  it("rejects schema-violating data with 422 template_record_schema_violation", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    const res = await req(
      "POST",
      `/v1/templates/${templateId}/template-records/questions`,
      apiKey,
      { data: { wrong: "no text field" } },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("template_record_schema_violation");
  });

  it("returns 404 on undeclared collection", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    const res = await req(
      "POST",
      `/v1/templates/${templateId}/template-records/unknown`,
      apiKey,
      { data: { text: "x" } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("template_record_collection_not_found");
  });

  it("rejects unauthenticated request with 401", async () => {
    const { agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    const res = await app.fetch(
      new Request(
        `http://t/v1/templates/${templateId}/template-records/questions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: { text: "x" } }),
        },
      ),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a non-owner agent with artifact_not_found", async () => {
    const owner = await seedAgent();
    const intruder = await seedAgent();
    const templateId = await seedTemplateWithRecords(owner.agentId);
    const res = await req(
      "POST",
      `/v1/templates/${templateId}/template-records/questions`,
      intruder.apiKey,
      { data: { text: "x" } },
    );
    // Owner scope returns artifact_not_found (404) to non-owners by design —
    // doesn't leak the existence of someone else's template.
    expect(res.status).toBe(404);
  });

  it("allows a claimed sibling agent to write", async () => {
    const owner = await seedAgent();
    const human = await prisma.human.create({
      data: { email: `h-${randomBytes(4).toString("hex")}@x.test` },
    });
    // Claim both agents to the same human.
    await prisma.agent.update({
      where: { id: owner.agentId },
      data: { ownerHumanId: human.id },
    });
    const sibling = await seedAgent();
    await prisma.agent.update({
      where: { id: sibling.agentId },
      data: { ownerHumanId: human.id },
    });
    const templateId = await seedTemplateWithRecords(owner.agentId);

    const res = await req(
      "POST",
      `/v1/templates/${templateId}/template-records/questions`,
      sibling.apiKey,
      { record_key: "from_sibling", data: { text: "hi" } },
    );
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET / (list)
// ---------------------------------------------------------------------------

describe("GET /v1/templates/:id/template-records/:collection", () => {
  it("returns an empty page for an unwritten collection", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    const res = await req(
      "GET",
      `/v1/templates/${templateId}/template-records/questions`,
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
    const templateId = await seedTemplateWithRecords(agentId);
    for (let i = 0; i < 5; i++) {
      await req(
        "POST",
        `/v1/templates/${templateId}/template-records/questions`,
        apiKey,
        { record_key: `q_${i}`, data: { text: String(i) } },
      );
    }
    const res = await req(
      "GET",
      `/v1/templates/${templateId}/template-records/questions?since=0&limit=2`,
      apiKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: { key: string }[];
      next_since: number;
      has_more: boolean;
    };
    expect(body.records.map((r) => r.key)).toEqual(["q_0", "q_1"]);
    expect(body.has_more).toBe(true);
  });

  it("works with the template's slug as the id parameter", async () => {
    const { apiKey, agentId } = await seedAgent();
    const tpl = await prisma.template.create({
      data: {
        ownerId: agentId,
        latestVersion: 1,
        name: "Sluggy",
        slug: "sluggy",
      },
    });
    await prisma.templateVersion.create({
      data: {
        templateId: tpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<html></html>",
        templateRecordSchema,
      },
    });
    await req(
      "POST",
      `/v1/templates/sluggy/template-records/questions`,
      apiKey,
      { record_key: "via-slug", data: { text: "by slug" } },
    );
    const res = await req(
      "GET",
      `/v1/templates/sluggy/template-records/questions`,
      apiKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { key: string }[] };
    expect(body.records.map((r) => r.key)).toEqual(["via-slug"]);
  });
});

// ---------------------------------------------------------------------------
// PATCH /:recordKey
// ---------------------------------------------------------------------------

describe("PATCH /v1/templates/:id/template-records/:collection/:key", () => {
  it("updates and bumps version", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    await req(
      "POST",
      `/v1/templates/${templateId}/template-records/questions`,
      apiKey,
      { record_key: "q1", data: { text: "v1" } },
    );
    const res = await req(
      "PATCH",
      `/v1/templates/${templateId}/template-records/questions/q1`,
      apiKey,
      { data: { text: "v2" }, if_match: 1 },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      record: { version: number; data: { text: string } };
    };
    expect(body.record.version).toBe(2);
    expect(body.record.data.text).toBe("v2");
  });

  it("returns 409 on if_match mismatch with current row in details", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    await req(
      "POST",
      `/v1/templates/${templateId}/template-records/questions`,
      apiKey,
      { record_key: "q1", data: { text: "v1" } },
    );
    const res = await req(
      "PATCH",
      `/v1/templates/${templateId}/template-records/questions/q1`,
      apiKey,
      { data: { text: "stale" }, if_match: 999 },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { current: { version: number } } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details.current.version).toBe(1);
  });

  it("returns 404 on missing record", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    const res = await req(
      "PATCH",
      `/v1/templates/${templateId}/template-records/questions/nope`,
      apiKey,
      { data: { text: "x" } },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:recordKey
// ---------------------------------------------------------------------------

describe("DELETE /v1/templates/:id/template-records/:collection/:key", () => {
  it("soft-deletes and returns 204", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    await req(
      "POST",
      `/v1/templates/${templateId}/template-records/questions`,
      apiKey,
      { record_key: "q1", data: { text: "v1" } },
    );
    const res = await req(
      "DELETE",
      `/v1/templates/${templateId}/template-records/questions/q1`,
      apiKey,
    );
    expect(res.status).toBe(204);

    // Listing without ?include — tombstones come back included; the client
    // is expected to filter, but the server emits.
    const list = await req(
      "GET",
      `/v1/templates/${templateId}/template-records/questions`,
      apiKey,
    );
    const body = (await list.json()) as {
      records: { deleted_at: string | null }[];
    };
    expect(body.records[0]!.deleted_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Method-not-allowed fallbacks
// ---------------------------------------------------------------------------

describe("method-not-allowed fallbacks", () => {
  it("returns 405 on PUT /:collection/:key", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    const res = await req(
      "PUT",
      `/v1/templates/${templateId}/template-records/questions/q1`,
      apiKey,
      { data: { text: "x" } },
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PATCH, DELETE");
  });

  it("returns 405 on PUT /:collection", async () => {
    const { apiKey, agentId } = await seedAgent();
    const templateId = await seedTemplateWithRecords(agentId);
    const res = await req(
      "PUT",
      `/v1/templates/${templateId}/template-records/questions`,
      apiKey,
      { data: { text: "x" } },
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
  });
});
