// E2E tests for the /my-templates/:id/content view + the cookie-authed
// write surface that backs it (/v1/my-templates/:id/template-records/...).
//
// The system-pages.e2e.test.ts file covers layout / general rendering;
// this file focuses on the specifics: ownership check, schema-driven
// rendering, and the full HTTP roundtrip an owner UI exercises.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";

import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { hashKey } from "../../keys.js";
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
      write: ["agent"],
      delete: ["agent"],
    },
  },
};

async function seedLoggedInHuman(): Promise<{
  humanId: string;
  cookie: string;
}> {
  const human = await prisma.human.create({
    data: {
      email: `tc-${randomBytes(4).toString("hex")}@e2e.local`,
      verifiedAt: new Date(),
    },
  });
  const cookieVal = randomBytes(24).toString("base64url");
  await prisma.login.create({
    data: {
      humanId: human.id,
      cookieHash: hashKey(cookieVal),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { humanId: human.id, cookie: `pane_login=${cookieVal}` };
}

async function seedClaimedAgent(humanId: string): Promise<{ agentId: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      ownerHumanId: humanId,
      claimedAt: new Date(),
    },
  });
  return { agentId: agent.id };
}

async function seedTemplate(
  agentId: string,
  withTplSchema = true,
): Promise<{ templateId: string }> {
  const tpl = await prisma.template.create({
    data: { ownerId: agentId, latestVersion: 1, name: "Survey" },
  });
  await prisma.templateVersion.create({
    data: {
      templateId: tpl.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      ...(withTplSchema ? { templateRecordSchema } : {}),
    },
  });
  return { templateId: tpl.id };
}

function withCookie(cookie: string): RequestInit {
  return { headers: { cookie } };
}

// ---------------------------------------------------------------------------
// GET /my-templates/:id/content
// ---------------------------------------------------------------------------

describe("GET /my-templates/:id/content", () => {
  it("renders the empty-state when the template declares no template_record_schema", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId } = await seedClaimedAgent(humanId);
    const { templateId } = await seedTemplate(agentId, false);
    const res = await app.fetch(
      new Request(
        `http://t/my-templates/${templateId}/content`,
        withCookie(cookie),
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No template-level collections declared");
    expect(html).toContain("template_record_schema");
  });

  it("renders one section per declared collection + the row UL the client hydrates", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId } = await seedClaimedAgent(humanId);
    const { templateId } = await seedTemplate(agentId, true);
    const res = await app.fetch(
      new Request(
        `http://t/my-templates/${templateId}/content`,
        withCookie(cookie),
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Section block for the declared collection.
    expect(html).toContain('data-collection="questions"');
    expect(html).toContain('class="trec-add"');
    expect(html).toContain("trec-rows");
    // Inline JS carries the template id and exposes the hydrate loop.
    expect(html).toContain("loadCollection");
    expect(html).toContain(JSON.stringify(templateId));
  });

  it("returns 404 to a non-owner human (no existence leak)", async () => {
    const alice = await seedLoggedInHuman();
    const aliceAgent = await seedClaimedAgent(alice.humanId);
    const { templateId } = await seedTemplate(aliceAgent.agentId, true);

    // Bob (different human) tries to load Alice's template.
    const bob = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(
        `http://t/my-templates/${templateId}/content`,
        withCookie(bob.cookie),
      ),
    );
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Template not found");
  });

  it("redirects-to-sign-in shape for logged-out callers", async () => {
    // No cookie, no human — the page renders the sign-in prompt rather
    // than 401-ing. (The other system pages follow the same pattern.)
    const res = await app.fetch(
      new Request(`http://t/my-templates/some-id/content`),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to see this page");
  });
});

// ---------------------------------------------------------------------------
// POST/PATCH/DELETE /v1/my-templates/:id/template-records/:collection
// ---------------------------------------------------------------------------

function jsonReq(
  method: string,
  url: string,
  cookie: string,
  body?: unknown,
): Request {
  return new Request(`http://t${url}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("cookie-authed write surface", () => {
  it("POST creates a row owned by author kind=human", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId } = await seedClaimedAgent(humanId);
    const { templateId } = await seedTemplate(agentId, true);
    const res = await app.fetch(
      jsonReq(
        "POST",
        `/v1/my-templates/${templateId}/template-records/questions`,
        cookie,
        { record_key: "q1", data: { text: "Why pane?" } },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      record: { key: string; author: { kind: string; id: string } };
    };
    expect(body.record.key).toBe("q1");
    expect(body.record.author.kind).toBe("human");
    expect(body.record.author.id).toBe(humanId);
  });

  it("non-owner human gets 404 even when they pass a valid cookie", async () => {
    const alice = await seedLoggedInHuman();
    const aliceAgent = await seedClaimedAgent(alice.humanId);
    const { templateId } = await seedTemplate(aliceAgent.agentId, true);
    const bob = await seedLoggedInHuman();
    const res = await app.fetch(
      jsonReq(
        "POST",
        `/v1/my-templates/${templateId}/template-records/questions`,
        bob.cookie,
        { data: { text: "intruder" } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("PATCH applies optimistic-lock + bumps version", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId } = await seedClaimedAgent(humanId);
    const { templateId } = await seedTemplate(agentId, true);
    await app.fetch(
      jsonReq(
        "POST",
        `/v1/my-templates/${templateId}/template-records/questions`,
        cookie,
        { record_key: "q1", data: { text: "v1" } },
      ),
    );
    const ok = await app.fetch(
      jsonReq(
        "PATCH",
        `/v1/my-templates/${templateId}/template-records/questions/q1`,
        cookie,
        { data: { text: "v2" }, if_match: 1 },
      ),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      record: { version: number; data: { text: string } };
    };
    expect(body.record.version).toBe(2);
    expect(body.record.data.text).toBe("v2");

    // Stale if_match → 409.
    const stale = await app.fetch(
      jsonReq(
        "PATCH",
        `/v1/my-templates/${templateId}/template-records/questions/q1`,
        cookie,
        { data: { text: "v3" }, if_match: 1 },
      ),
    );
    expect(stale.status).toBe(409);
  });

  it("DELETE soft-deletes and the row's _deleted is visible in GET", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId } = await seedClaimedAgent(humanId);
    const { templateId } = await seedTemplate(agentId, true);
    await app.fetch(
      jsonReq(
        "POST",
        `/v1/my-templates/${templateId}/template-records/questions`,
        cookie,
        { record_key: "q1", data: { text: "live" } },
      ),
    );
    const del = await app.fetch(
      new Request(
        `http://t/v1/my-templates/${templateId}/template-records/questions/q1`,
        { method: "DELETE", headers: { cookie } },
      ),
    );
    expect(del.status).toBe(204);

    const list = await app.fetch(
      new Request(
        `http://t/v1/my-templates/${templateId}/template-records/questions`,
        { headers: { cookie } },
      ),
    );
    expect(list.status).toBe(200);
    const lst = (await list.json()) as {
      records: Array<{ deleted_at: string | null }>;
    };
    expect(lst.records.length).toBe(1);
    expect(lst.records[0]!.deleted_at).not.toBeNull();
  });
});
