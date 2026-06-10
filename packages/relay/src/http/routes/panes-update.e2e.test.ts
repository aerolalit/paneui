// End-to-end tests for PATCH /v1/panes/:id (#502).
//
// The route edits instance-level fields on a live pane in place — TTL/expires_at,
// title, preamble, metadata, tags, input_data, and the per-pane icon overrides
// — without minting a new pane. The pane keeps its id, URL, event log and
// template pin. Validation mirrors POST /v1/panes for each editable field, so
// the PATCH can't introduce a state the original create wouldn't have allowed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;

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

// Seed an agent + a template version (carrying an optional input_schema) +
// a pane pinned to that version. Returns everything callers need to PATCH.
async function seedPane(opts?: {
  inputSchema?: object;
  paneOverrides?: Partial<{
    deletedAt: Date | null;
    status: "open" | "closed";
    expiresAt: Date;
    title: string;
    preamble: string | null;
  }>;
}): Promise<{
  apiKey: string;
  agentId: string;
  templateId: string;
  versionId: string;
  paneId: string;
}> {
  const apiKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  const tmpl = await prisma.template.create({
    data: {
      ownerId: agent.id,
      name: "Test",
      slug: `tmpl-${randomBytes(3).toString("hex")}`,
      latestVersion: 1,
    },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: tmpl.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>v1</p>",
      eventSchema: {
        events: {
          "feed.logged": {
            emittedBy: ["page"],
            payload: { type: "object" },
          },
        },
      },
      ...(opts?.inputSchema !== undefined
        ? { inputSchema: opts.inputSchema }
        : {}),
    },
  });
  const paneId = `pan_${randomBytes(8).toString("hex")}`;
  await prisma.pane.create({
    data: {
      id: paneId,
      agentId: agent.id,
      templateVersionId: version.id,
      title: opts?.paneOverrides?.title ?? "Test pane",
      preamble: opts?.paneOverrides?.preamble ?? null,
      status: opts?.paneOverrides?.status ?? "open",
      expiresAt:
        opts?.paneOverrides?.expiresAt ?? new Date(Date.now() + 3_600_000),
      deletedAt: opts?.paneOverrides?.deletedAt ?? null,
    },
  });
  return {
    apiKey,
    agentId: agent.id,
    templateId: tmpl.id,
    versionId: version.id,
    paneId,
  };
}

function patchPane(
  paneId: string,
  apiKey: string,
  body: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/panes/${paneId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH /v1/panes/:id — TTL / expires_at", () => {
  it("extends a pane's TTL in place — pane_id and URL unchanged", async () => {
    const { apiKey, paneId } = await seedPane();
    const before = await prisma.pane.findUnique({ where: { id: paneId } });

    const res = await patchPane(paneId, apiKey, { ttl: 86400 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pane_id: string;
      expires_at: string;
      updated_fields: string[];
    };
    expect(body.pane_id).toBe(paneId);
    expect(body.updated_fields).toEqual(["ttl"]);

    const after = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(after!.expiresAt.getTime()).toBeGreaterThan(
      before!.expiresAt.getTime(),
    );
    // Within a few seconds of now + 86400s.
    const expectedMs = Date.now() + 86400 * 1000;
    expect(Math.abs(after!.expiresAt.getTime() - expectedMs)).toBeLessThan(
      5000,
    );
  });

  it("accepts an explicit expires_at timestamp", async () => {
    const { apiKey, paneId } = await seedPane();
    const target = new Date(Date.now() + 7200 * 1000).toISOString();
    const res = await patchPane(paneId, apiKey, { expires_at: target });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { expires_at: string };
    expect(new Date(body.expires_at).toISOString()).toBe(target);
  });

  it("rejects ttl above MAX_TTL_SECONDS", async () => {
    const { apiKey, paneId } = await seedPane();
    const res = await patchPane(paneId, apiKey, { ttl: 365 * 24 * 3600 * 10 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects expires_at in the past", async () => {
    const { apiKey, paneId } = await seedPane();
    const res = await patchPane(paneId, apiKey, {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects ttl and expires_at together", async () => {
    const { apiKey, paneId } = await seedPane();
    const res = await patchPane(paneId, apiKey, {
      ttl: 3600,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /v1/panes/:id — title / preamble / tags / metadata", () => {
  it("updates title and preamble", async () => {
    const { apiKey, paneId } = await seedPane();
    const res = await patchPane(paneId, apiKey, {
      title: "Renamed",
      preamble: "Why this matters",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string;
      updated_fields: string[];
    };
    expect(body.title).toBe("Renamed");
    expect(body.updated_fields).toEqual(
      expect.arrayContaining(["title", "preamble"]),
    );
    const row = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(row!.title).toBe("Renamed");
    expect(row!.preamble).toBe("Why this matters");
  });

  it("replaces tags wholesale and merges template tags", async () => {
    const { apiKey, paneId, templateId } = await seedPane();
    await prisma.template.update({
      where: { id: templateId },
      data: { tags: ["template-tag"] },
    });
    const res = await patchPane(paneId, apiKey, {
      tags: ["instance-a", "instance-b"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    // Template tags lead, instance tags follow.
    expect(body.tags).toEqual(["template-tag", "instance-a", "instance-b"]);
  });

  it("rejects reserved tag names", async () => {
    const { apiKey, paneId } = await seedPane();
    const res = await patchPane(paneId, apiKey, { tags: ["favorite"] });
    expect(res.status).toBe(400);
  });

  it("replaces metadata wholesale", async () => {
    const { apiKey, paneId } = await seedPane();
    await patchPane(paneId, apiKey, { metadata: { a: 1, b: 2 } });
    const res = await patchPane(paneId, apiKey, { metadata: { c: 3 } });
    expect(res.status).toBe(200);
    const row = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(row!.metadata).toEqual({ c: 3 });
  });
});

describe("PATCH /v1/panes/:id — input_data", () => {
  it("replaces input_data and revalidates against the pinned schema", async () => {
    const inputSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const { apiKey, paneId } = await seedPane({ inputSchema });

    // Happy path.
    const ok = await patchPane(paneId, apiKey, {
      input_data: { name: "Livia" },
    });
    expect(ok.status).toBe(200);
    const row = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(row!.inputData).toEqual({ name: "Livia" });

    // Missing required → 422 input_schema_violation (same gate as create).
    const bad = await patchPane(paneId, apiKey, { input_data: {} });
    expect(bad.status).toBe(422);
    const badBody = (await bad.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe("input_schema_violation");
  });
});

describe("PATCH /v1/panes/:id — icon overrides", () => {
  it("clears the icon_emoji when null is sent", async () => {
    const { apiKey, paneId } = await seedPane();
    await prisma.pane.update({
      where: { id: paneId },
      data: { iconEmoji: "👶" },
    });
    const res = await patchPane(paneId, apiKey, { icon_emoji: null });
    expect(res.status).toBe(200);
    const row = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(row!.iconEmoji).toBeNull();
  });
});

describe("PATCH /v1/panes/:id — guards", () => {
  it("returns 400 invalid_request when no fields are supplied", async () => {
    const { apiKey, paneId } = await seedPane();
    const res = await patchPane(paneId, apiKey, {});
    expect(res.status).toBe(400);
  });

  it("returns 410 on a soft-deleted pane", async () => {
    const { apiKey, paneId } = await seedPane({
      paneOverrides: { deletedAt: new Date() },
    });
    const res = await patchPane(paneId, apiKey, { ttl: 3600 });
    expect(res.status).toBe(410);
  });

  it("returns 410 on a closed pane", async () => {
    const { apiKey, paneId } = await seedPane({
      paneOverrides: { status: "closed" },
    });
    const res = await patchPane(paneId, apiKey, { ttl: 3600 });
    expect(res.status).toBe(410);
  });

  it("returns 410 on an expired pane", async () => {
    const { apiKey, paneId } = await seedPane({
      paneOverrides: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await patchPane(paneId, apiKey, { ttl: 3600 });
    expect(res.status).toBe(410);
  });

  it("returns 404 when called by an unrelated agent", async () => {
    const { paneId } = await seedPane();
    // A different agent with no claim to the same human.
    const otherKey = generateApiKey();
    await prisma.agent.create({
      data: {
        name: `other-${randomBytes(4).toString("hex")}`,
        keyHash: hashKey(otherKey),
        keyPrefix: keyPrefix(otherKey),
      },
    });
    const res = await patchPane(paneId, otherKey, { ttl: 3600 });
    expect(res.status).toBe(404);
  });

  it("appends system.pane.updated with the changed field names", async () => {
    const { apiKey, paneId } = await seedPane();
    await patchPane(paneId, apiKey, {
      title: "New",
      metadata: { foo: "bar" },
    });
    const events = await prisma.event.findMany({
      where: { paneId, type: "system.pane.updated" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({
      fields: expect.arrayContaining(["title", "metadata"]),
    });
  });
});
