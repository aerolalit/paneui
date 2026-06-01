// Regression test for #350: record_schema was validated on every create path
// but never written to the TemplateVersion row, so every records HTTP/WS
// operation against a freshly-created pane returned record_collection_not_found
// (record_schema is null). This file pins the column-presence contract end-to-
// end so the three create paths can't silently drop record_schema again.

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

// A minimal but valid record_schema with one collection — same shape used by
// records.e2e.test.ts so we know the records routes accept it.
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
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: bearer(apiKey),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

describe("record_schema persistence (#350)", () => {
  it("POST /v1/panes (inline form) persists record_schema and accepts records writes", async () => {
    const apiKey = await seedAgent();

    const createRes = await req("POST", "/v1/panes", apiKey, {
      title: "records-persist e2e",
      template: {
        type: "html-inline",
        source: "<html></html>",
        record_schema: recordSchema,
      },
    });
    expect(createRes.status).toBe(201);
    const { pane_id } = (await createRes.json()) as { pane_id: string };

    // Round-trip the column via Prisma directly — the load-bearing assertion.
    // Before the fix, this was always null even though the validator accepted
    // the schema on the way in.
    const pane = await prisma.pane.findUniqueOrThrow({
      where: { id: pane_id },
      include: { templateVersion: true },
    });
    expect(pane.templateVersion.recordSchema).not.toBeNull();
    expect(pane.templateVersion.recordSchema).toEqual(recordSchema);

    // And the records route now sees the collection — no more
    // record_collection_not_found on a freshly-created pane.
    const writeRes = await req(
      "POST",
      `/v1/panes/${pane_id}/records/comments`,
      apiKey,
      { record_key: "cmt_1", data: { body: "hello" } },
    );
    expect(writeRes.status).toBe(201);
    const writeBody = (await writeRes.json()) as { record: { key: string } };
    expect(writeBody.record.key).toBe("cmt_1");
  });

  it("POST /v1/templates persists record_schema on v1", async () => {
    const apiKey = await seedAgent();

    const createRes = await req("POST", "/v1/templates", apiKey, {
      name: "Comments template",
      slug: "comments-template",
      source: "<html></html>",
      type: "html-inline",
      record_schema: recordSchema,
    });
    expect(createRes.status).toBe(201);
    const { template_id } = (await createRes.json()) as { template_id: string };

    const versions = await prisma.templateVersion.findMany({
      where: { templateId: template_id },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.recordSchema).toEqual(recordSchema);
  });

  it("POST /v1/templates/:id/versions persists record_schema on the new version", async () => {
    const apiKey = await seedAgent();

    // v1: no record_schema.
    const create = await req("POST", "/v1/templates", apiKey, {
      name: "Versioned template",
      slug: "versioned-template",
      source: "<html></html>",
      type: "html-inline",
    });
    expect(create.status).toBe(201);
    const { template_id } = (await create.json()) as { template_id: string };

    // v2: introduce a record_schema.
    const v2 = await req(
      "POST",
      `/v1/templates/${template_id}/versions`,
      apiKey,
      {
        source: "<html></html>",
        type: "html-inline",
        record_schema: recordSchema,
      },
    );
    expect(v2.status).toBe(201);

    const versions = await prisma.templateVersion.findMany({
      where: { templateId: template_id },
      orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0]!.recordSchema).toBeNull();
    expect(versions[1]!.recordSchema).toEqual(recordSchema);
  });
});
