// End-to-end tests for the usage-maturity open-pane gates on templates:
//   - GET /v1/templates list gate (TEMPLATE_LIST_MIN_OPEN_PANES)
//   - POST /v1/templates/:id/publish gate (TEMPLATE_PUBLISH_MIN_OPEN_PANES)
//
// "Currently-open" pane = status=open AND deletedAt=null AND expiresAt>now,
// counted across ALL TemplateVersions of the template. Each describe block
// builds its own app instance so it can pin the relevant threshold (and the
// disabled=0 case) explicitly. DB engine follows DATABASE_URL.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import {
  generateApiKey,
  generatePaneId,
  hashKey,
  keyPrefix,
} from "../../keys.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

function buildAppWith(env: Record<string, string>): Hono {
  return buildApp(
    loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
      ...env,
    }),
    prisma,
  );
}

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: agent.id, apiKey };
}

// A template + its v1 TemplateVersion, owned by `ownerAgentId`.
async function seedTemplateWithVersion(
  ownerAgentId: string,
  name = "tpl",
): Promise<{ templateId: string; versionId: string }> {
  const tmpl = await prisma.template.create({
    data: { ownerId: ownerAgentId, name, latestVersion: 1 },
  });
  const v1 = await prisma.templateVersion.create({
    data: {
      templateId: tmpl.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>v1</p>",
      eventSchema: null,
    },
  });
  return { templateId: tmpl.id, versionId: v1.id };
}

// Create one pane pinned to `versionId`. Defaults = currently-open
// (status=open, not deleted, expires in the future). Override per-knob to
// build the "does not count" cases.
async function seedPane(
  agentId: string,
  versionId: string,
  opts: {
    status?: "open" | "closed";
    deleted?: boolean;
    expired?: boolean;
  } = {},
): Promise<void> {
  const now = Date.now();
  await prisma.pane.create({
    data: {
      id: generatePaneId(),
      agentId,
      templateVersionId: versionId,
      title: "p",
      status: opts.status ?? "open",
      expiresAt: new Date(opts.expired ? now - 60_000 : now + 60 * 60_000),
      deletedAt: opts.deleted ? new Date(now - 60_000) : null,
    },
  });
}

async function listTemplates(
  app: Hono,
  apiKey: string,
  query = "",
): Promise<{ id: string; name: string | null }[]> {
  const res = await app.fetch(
    new Request(`http://t/v1/templates${query}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    templates: { id: string; name: string | null }[];
  };
  return body.templates;
}

// -------------------------------------------------------------------------
// List gate — GET /v1/templates
// -------------------------------------------------------------------------
describe("GET /v1/templates — open-pane list gate", () => {
  it("hides a template with fewer than the threshold of open panes", async () => {
    const app = buildAppWith({ TEMPLATE_LIST_MIN_OPEN_PANES: "2" });
    const owner = await seedAgent();
    const { versionId } = await seedTemplateWithVersion(owner.id, "BelowGate");
    await seedPane(owner.id, versionId); // only 1 open pane, threshold is 2
    const rows = await listTemplates(app, owner.apiKey);
    expect(rows).toHaveLength(0);
  });

  it("shows a template at or above the threshold", async () => {
    const app = buildAppWith({ TEMPLATE_LIST_MIN_OPEN_PANES: "2" });
    const owner = await seedAgent();
    const { templateId, versionId } = await seedTemplateWithVersion(
      owner.id,
      "AtGate",
    );
    await seedPane(owner.id, versionId);
    await seedPane(owner.id, versionId); // exactly 2 — the boundary
    const rows = await listTemplates(app, owner.apiKey);
    expect(rows.map((r) => r.id)).toEqual([templateId]);
  });

  it("sums open panes across multiple versions of the same template", async () => {
    const app = buildAppWith({ TEMPLATE_LIST_MIN_OPEN_PANES: "2" });
    const owner = await seedAgent();
    const { templateId, versionId } = await seedTemplateWithVersion(
      owner.id,
      "MultiVersion",
    );
    // A second version on the same template, one open pane on each.
    const v2 = await prisma.templateVersion.create({
      data: {
        templateId,
        version: 2,
        templateType: "html-inline",
        templateSource: "<p>v2</p>",
        eventSchema: null,
      },
    });
    await prisma.template.update({
      where: { id: templateId },
      data: { latestVersion: 2 },
    });
    await seedPane(owner.id, versionId);
    await seedPane(owner.id, v2.id);
    const rows = await listTemplates(app, owner.apiKey);
    expect(rows.map((r) => r.id)).toEqual([templateId]);
  });

  it("does not count closed, expired, or soft-deleted panes", async () => {
    const app = buildAppWith({ TEMPLATE_LIST_MIN_OPEN_PANES: "2" });
    const owner = await seedAgent();
    const { versionId } = await seedTemplateWithVersion(owner.id, "OnlyJunk");
    // One genuinely-open pane plus three that must NOT count — total
    // eligible = 1, below the threshold of 2, so the template is hidden.
    await seedPane(owner.id, versionId); // open
    await seedPane(owner.id, versionId, { status: "closed" });
    await seedPane(owner.id, versionId, { expired: true });
    await seedPane(owner.id, versionId, { deleted: true });
    const rows = await listTemplates(app, owner.apiKey);
    expect(rows).toHaveLength(0);
  });

  it("lists everything when the gate is disabled (=0)", async () => {
    const app = buildAppWith({ TEMPLATE_LIST_MIN_OPEN_PANES: "0" });
    const owner = await seedAgent();
    const { templateId } = await seedTemplateWithVersion(owner.id, "NoPanes");
    // Zero open panes, but the gate is off — it still lists.
    const rows = await listTemplates(app, owner.apiKey);
    expect(rows.map((r) => r.id)).toEqual([templateId]);
  });

  it("does not apply the gate to the ?include_deleted=true trash view", async () => {
    const app = buildAppWith({ TEMPLATE_LIST_MIN_OPEN_PANES: "2" });
    const owner = await seedAgent();
    const { templateId } = await seedTemplateWithVersion(owner.id, "Trashed");
    // Soft-delete the template head — a trashed template has no open panes,
    // but the trash view must still surface it for restore/purge.
    await prisma.template.update({
      where: { id: templateId },
      data: { deletedAt: new Date() },
    });
    const hidden = await listTemplates(app, owner.apiKey);
    expect(hidden).toHaveLength(0);
    const trash = await listTemplates(
      app,
      owner.apiKey,
      "?include_deleted=true",
    );
    expect(trash.map((r) => r.id)).toEqual([templateId]);
  });
});

// -------------------------------------------------------------------------
// Publish gate — POST /v1/templates/:id/publish
// -------------------------------------------------------------------------
describe("POST /v1/templates/:id/publish — open-pane publish gate", () => {
  async function publish(
    app: Hono,
    templateId: string,
    apiKey: string,
  ): Promise<Response> {
    return app.fetch(
      new Request(`http://t/v1/templates/${templateId}/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({}),
      }),
    );
  }

  it("blocks the first publish when open panes are below the threshold", async () => {
    const app = buildAppWith({ TEMPLATE_PUBLISH_MIN_OPEN_PANES: "5" });
    const owner = await seedAgent();
    const { templateId, versionId } = await seedTemplateWithVersion(owner.id);
    for (let i = 0; i < 4; i++) await seedPane(owner.id, versionId); // 4 < 5
    const res = await publish(app, templateId, owner.apiKey);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toMatch(/at least 5 open panes/);
    expect(body.error.message).toMatch(/currently 4/);
    // Not published.
    const after = await prisma.template.findUnique({
      where: { id: templateId },
    });
    expect(after!.publishedAt).toBeNull();
  });

  it("allows the first publish when open panes are above the threshold", async () => {
    const app = buildAppWith({ TEMPLATE_PUBLISH_MIN_OPEN_PANES: "5" });
    const owner = await seedAgent();
    const { templateId, versionId } = await seedTemplateWithVersion(owner.id);
    for (let i = 0; i < 6; i++) await seedPane(owner.id, versionId); // 6 > 5
    const res = await publish(app, templateId, owner.apiKey);
    expect(res.status).toBe(200);
    const after = await prisma.template.findUnique({
      where: { id: templateId },
    });
    expect(after!.publishedAt).not.toBeNull();
  });

  it("allows publish exactly at the threshold (boundary)", async () => {
    const app = buildAppWith({ TEMPLATE_PUBLISH_MIN_OPEN_PANES: "5" });
    const owner = await seedAgent();
    const { templateId, versionId } = await seedTemplateWithVersion(owner.id);
    for (let i = 0; i < 5; i++) await seedPane(owner.id, versionId); // exactly 5
    const res = await publish(app, templateId, owner.apiKey);
    expect(res.status).toBe(200);
  });

  it("does not count closed / expired / soft-deleted panes toward the threshold", async () => {
    const app = buildAppWith({ TEMPLATE_PUBLISH_MIN_OPEN_PANES: "2" });
    const owner = await seedAgent();
    const { templateId, versionId } = await seedTemplateWithVersion(owner.id);
    await seedPane(owner.id, versionId); // 1 open — below threshold of 2
    await seedPane(owner.id, versionId, { status: "closed" });
    await seedPane(owner.id, versionId, { expired: true });
    await seedPane(owner.id, versionId, { deleted: true });
    const res = await publish(app, templateId, owner.apiKey);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/currently 1/);
  });

  it("skips the gate when re-publishing an already-published template", async () => {
    const app = buildAppWith({ TEMPLATE_PUBLISH_MIN_OPEN_PANES: "5" });
    const owner = await seedAgent();
    // Already published (publishedAt set), with zero open panes — a
    // re-publish (e.g. to update scopes) must still succeed.
    const tmpl = await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "AlreadyPublished",
        latestVersion: 1,
        publishedAt: new Date(Date.now() - 60_000),
      },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tmpl.id}/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.apiKey}`,
        },
        body: JSON.stringify({ scopes: ["read:panes"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["read:panes"]);
  });

  it("disables the gate when TEMPLATE_PUBLISH_MIN_OPEN_PANES=0", async () => {
    const app = buildAppWith({ TEMPLATE_PUBLISH_MIN_OPEN_PANES: "0" });
    const owner = await seedAgent();
    const { templateId } = await seedTemplateWithVersion(owner.id);
    // Zero open panes, gate off — first publish goes through.
    const res = await publish(app, templateId, owner.apiKey);
    expect(res.status).toBe(200);
    const after = await prisma.template.findUnique({
      where: { id: templateId },
    });
    expect(after!.publishedAt).not.toBeNull();
  });
});
