// E2E tests for the Query API's template-record integration (PR C of the
// template-records epic).
//
// Verifies:
//   - SELECT * FROM template_records returns the raw template-record rows
//     for templates referenced by the caller's panes.
//   - SELECT * FROM tpl_<collection> exposes the schema-compiled typed view
//     for a template-level collection (text, weight, key, template_id, _seq).
//   - Scope isolation: an agent's query never sees another human's template
//     records, even when that other template happens to share a collection
//     name.
//   - Per-pane records and template records sit in separate views — same
//     collection name `questions` resolves to `questions` (per-pane) vs
//     `tpl_questions` (template-level) and they don't bleed into each other.

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

async function seedTemplateWithSchema(
  agentId: string,
): Promise<{ templateId: string; versionId: string }> {
  const tpl = await prisma.template.create({
    data: { ownerId: agentId, latestVersion: 1, name: "Survey" },
  });
  const v = await prisma.templateVersion.create({
    data: {
      templateId: tpl.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      templateRecordSchema,
    },
  });
  return { templateId: tpl.id, versionId: v.id };
}

async function seedPaneFromTemplate(
  agentId: string,
  versionId: string,
): Promise<string> {
  const paneId = `pan_${randomBytes(8).toString("hex")}`;
  await prisma.pane.create({
    data: {
      id: paneId,
      agentId,
      templateVersionId: versionId,
      title: "derived",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return paneId;
}

async function seedTemplateRecord(
  templateId: string,
  collectionName: string,
  data: object,
  key?: string,
): Promise<void> {
  const coll = await prisma.templateRecordCollection.upsert({
    where: {
      templateId_name: { templateId, name: collectionName },
    },
    create: { templateId, name: collectionName, seq: 0 },
    update: {},
  });
  const bumped = await prisma.templateRecordCollection.update({
    where: { id: coll.id },
    data: { seq: { increment: 1 } },
  });
  await prisma.templateRecord.create({
    data: {
      collectionId: coll.id,
      recordKey: key ?? `trec_${randomBytes(6).toString("hex")}`,
      data,
      version: 1,
      seq: bumped.seq,
      authorKind: "agent",
      authorId: "test",
    },
  });
}

function query(apiKey: string, sql: string): Promise<Response> {
  return app.fetch(
    new Request("http://t/v1/query", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql }),
    }),
  );
}

describe("Query API — template-record views", () => {
  it("exposes template_records via the generic view", async () => {
    const { apiKey, agentId } = await seedAgent();
    const { templateId, versionId } = await seedTemplateWithSchema(agentId);
    await seedTemplateRecord(templateId, "questions", {
      text: "Why pane?",
    });
    await seedTemplateRecord(templateId, "questions", {
      text: "Why now?",
    });
    await seedPaneFromTemplate(agentId, versionId);

    const res = await query(
      apiKey,
      "SELECT collection, json_extract_string(data, '$.text') AS text FROM template_records ORDER BY seq",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: unknown[][];
    };
    expect(body.columns).toEqual(["collection", "text"]);
    expect(body.rows).toEqual([
      ["questions", "Why pane?"],
      ["questions", "Why now?"],
    ]);
  });

  it("exposes per-template-collection typed view as tpl_<collection>", async () => {
    const { apiKey, agentId } = await seedAgent();
    const { templateId, versionId } = await seedTemplateWithSchema(agentId);
    await seedTemplateRecord(templateId, "questions", {
      text: "First",
      weight: 1.5,
    });
    await seedTemplateRecord(templateId, "questions", {
      text: "Second",
      weight: 2.5,
    });
    await seedPaneFromTemplate(agentId, versionId);

    const res = await query(
      apiKey,
      "SELECT text, weight, key, template_id FROM tpl_questions ORDER BY _seq",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: unknown[][];
    };
    expect(body.columns).toEqual(["text", "weight", "key", "template_id"]);
    expect(body.rows.length).toBe(2);
    // Row 0: First, 1.5, <key>, <templateId>.
    expect(body.rows[0]![0]).toBe("First");
    expect(body.rows[0]![1]).toBe(1.5);
    expect(body.rows[0]![3]).toBe(templateId);
  });

  it("isolates scope — another human's template records aren't visible", async () => {
    // Set up agent A with a template + records and a derived pane.
    const a = await seedAgent();
    const aTpl = await seedTemplateWithSchema(a.agentId);
    await seedTemplateRecord(aTpl.templateId, "questions", {
      text: "Alice's question",
    });
    await seedPaneFromTemplate(a.agentId, aTpl.versionId);

    // Set up agent B with their own template + records but NO derived pane
    // shared with agent A — A's scope shouldn't see any of B's data.
    const b = await seedAgent();
    const bTpl = await seedTemplateWithSchema(b.agentId);
    await seedTemplateRecord(bTpl.templateId, "questions", {
      text: "Bob's question",
    });
    await seedPaneFromTemplate(b.agentId, bTpl.versionId);

    const res = await query(
      a.apiKey,
      "SELECT json_extract_string(data, '$.text') AS text FROM template_records ORDER BY 1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[][] };
    expect(body.rows).toEqual([["Alice's question"]]);
  });

  it("returns empty rows when the caller has no derived panes", async () => {
    const { apiKey } = await seedAgent();
    const res = await query(apiKey, "SELECT * FROM template_records");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[][] };
    expect(body.rows).toEqual([]);
  });

  it("does not include soft-deleted template records as live rows in tpl_*", async () => {
    const { apiKey, agentId } = await seedAgent();
    const { templateId, versionId } = await seedTemplateWithSchema(agentId);
    await seedTemplateRecord(templateId, "questions", { text: "live" }, "live");
    // Insert a tombstone directly.
    const coll = await prisma.templateRecordCollection.findUnique({
      where: { templateId_name: { templateId, name: "questions" } },
    });
    await prisma.templateRecord.create({
      data: {
        collectionId: coll!.id,
        recordKey: "deleted",
        data: { text: "gone" },
        version: 1,
        seq: 999,
        authorKind: "agent",
        authorId: "test",
        deletedAt: new Date(),
      },
    });
    await seedPaneFromTemplate(agentId, versionId);

    const res = await query(
      apiKey,
      "SELECT text, _deleted FROM tpl_questions ORDER BY key",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: unknown[][];
    };
    // tpl_<collection> follows the same convention as the per-pane view —
    // tombstones are visible with _deleted=true; the caller filters via
    // WHERE _deleted = false when they want only live rows.
    expect(body.columns).toEqual(["text", "_deleted"]);
    expect(body.rows.length).toBe(2);
    const live = body.rows.filter((r) => r[1] === false);
    expect(live.length).toBe(1);
    expect(live[0]![0]).toBe("live");
  });
});
