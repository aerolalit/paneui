// End-to-end tests for Phase F — public catalog + install flow (§8).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";
import {
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
} from "../../auth/cookie.js";

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

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      name: "publisher",
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: agent.id, apiKey };
}

async function seedTemplate(ownerAgentId: string, name = "tpl") {
  return prisma.template.create({
    data: { ownerId: ownerAgentId, name, latestVersion: 1 },
  });
}

async function seedLoggedInHuman(email = "alice@example.com"): Promise<{
  humanId: string;
  cookie: string;
}> {
  const human = await prisma.human.create({
    data: { email, verifiedAt: new Date() },
  });
  const cookie = generateLoginCookie();
  await prisma.login.create({
    data: {
      humanId: human.id,
      cookieHash: hashLoginCookie(cookie),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { humanId: human.id, cookie };
}

const withCookie = (cookie: string) => ({
  cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
});

describe("POST /v1/templates/:id/publish (agent)", () => {
  it("requires an agent bearer token", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/templates/x/publish", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects publish on a template the agent doesn't own (404 no oracle)", async () => {
    const owner = await seedAgent();
    const other = await seedAgent();
    const tmpl = await seedTemplate(owner.id);
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tmpl.id}/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${other.apiKey}`,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("sets publishedAt + stores scopes", async () => {
    const owner = await seedAgent();
    const tmpl = await seedTemplate(owner.id);
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tmpl.id}/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.apiKey}`,
        },
        body: JSON.stringify({ scopes: ["read:panes", "write:events"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      published_at: string | null;
      scopes: string[];
    };
    expect(body.published_at).not.toBeNull();
    expect(body.scopes).toEqual(["read:panes", "write:events"]);
    const after = await prisma.template.findUnique({ where: { id: tmpl.id } });
    expect(after?.publishedAt).not.toBeNull();
  });

  it("rejects scope strings that don't match verb:noun", async () => {
    const owner = await seedAgent();
    const tmpl = await seedTemplate(owner.id);
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tmpl.id}/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.apiKey}`,
        },
        body: JSON.stringify({ scopes: ["totally-not-a-scope"] }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/templates/:id/unpublish (agent)", () => {
  it("clears publishedAt", async () => {
    const owner = await seedAgent();
    const tmpl = await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "t",
        publishedAt: new Date(),
        scopes: ["read:panes"] as unknown as object,
      },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tmpl.id}/unpublish`, {
        method: "POST",
        headers: { authorization: `Bearer ${owner.apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.template.findUnique({ where: { id: tmpl.id } });
    expect(after?.publishedAt).toBeNull();
  });
});

describe("GET /v1/templates/public (human)", () => {
  it("requires a login cookie", async () => {
    const res = await app.fetch(new Request("http://t/v1/templates/public"));
    expect(res.status).toBe(401);
  });

  it("lists only published templates, with install_count ordering", async () => {
    const owner = await seedAgent();
    await prisma.template.create({
      data: { ownerId: owner.id, name: "Private (not published)" },
    });
    await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Public A",
        publishedAt: new Date(Date.now() - 60_000),
        installCount: 10,
      },
    });
    await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Public B",
        publishedAt: new Date(Date.now() - 30_000),
        installCount: 100,
      },
    });
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/v1/templates/public", {
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { name: string; install_count: number; installed: boolean }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.items.length).toBe(2);
    // Highest install_count first
    expect(body.items[0]!.name).toBe("Public B");
    expect(body.items[1]!.name).toBe("Public A");
    expect(body.items[0]!.installed).toBe(false);
  });

  it("?q= filters by name, description, and tags (case-insensitive)", async () => {
    const owner = await seedAgent();
    await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Picture Review",
        description: "Tool for image review",
        tags: ["images"],
        publishedAt: new Date(Date.now() - 30_000),
        installCount: 1,
      },
    });
    await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "PR Reviewer",
        description: "Approve or request changes on pull requests",
        tags: ["code", "github"],
        publishedAt: new Date(Date.now() - 20_000),
        installCount: 5,
      },
    });
    await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Survey",
        description: "Generic ranking form",
        tags: ["forms"],
        publishedAt: new Date(Date.now() - 10_000),
        installCount: 2,
      },
    });
    const { cookie } = await seedLoggedInHuman();

    const byName = (await (
      await app.fetch(
        new Request("http://t/v1/templates/public?q=PR", {
          headers: withCookie(cookie),
        }),
      )
    ).json()) as { items: { name: string }[]; total: number };
    expect(byName.total).toBe(1);
    expect(byName.items[0]!.name).toBe("PR Reviewer");

    const byDesc = (await (
      await app.fetch(
        new Request("http://t/v1/templates/public?q=ranking", {
          headers: withCookie(cookie),
        }),
      )
    ).json()) as { items: { name: string }[]; total: number };
    expect(byDesc.total).toBe(1);
    expect(byDesc.items[0]!.name).toBe("Survey");

    const byTag = (await (
      await app.fetch(
        new Request("http://t/v1/templates/public?q=GITHUB", {
          headers: withCookie(cookie),
        }),
      )
    ).json()) as { items: { name: string }[]; total: number };
    expect(byTag.total).toBe(1);
    expect(byTag.items[0]!.name).toBe("PR Reviewer");

    const noHit = (await (
      await app.fetch(
        new Request("http://t/v1/templates/public?q=nopenope", {
          headers: withCookie(cookie),
        }),
      )
    ).json()) as { items: unknown[]; total: number };
    expect(noHit.total).toBe(0);
    expect(noHit.items).toEqual([]);
  });

  it("marks installed templates with installed=true", async () => {
    const owner = await seedAgent();
    const tmpl = await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Reviewer",
        publishedAt: new Date(),
        latestVersion: 3,
      },
    });
    const { humanId, cookie } = await seedLoggedInHuman();
    await prisma.humanTemplateInstall.create({
      data: {
        humanId,
        templateId: tmpl.id,
        installedVersion: 3,
      },
    });
    const res = await app.fetch(
      new Request("http://t/v1/templates/public", {
        headers: withCookie(cookie),
      }),
    );
    const body = (await res.json()) as {
      items: { installed: boolean; installed_version: number | null }[];
    };
    expect(body.items[0]!.installed).toBe(true);
    expect(body.items[0]!.installed_version).toBe(3);
  });
});

describe("POST /v1/templates/:id/install (human)", () => {
  it("requires a login cookie", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/templates/x/install", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("404 on unknown / unpublished templates", async () => {
    const owner = await seedAgent();
    const tmpl = await seedTemplate(owner.id);
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tmpl.id}/install`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("creates install row, pins version, bumps install_count", async () => {
    const owner = await seedAgent();
    const tmpl = await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Reviewer",
        publishedAt: new Date(),
        latestVersion: 5,
        installCount: 0,
      },
    });
    const { humanId, cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tmpl.id}/install`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      template_id: string;
      installed_version: number;
    };
    expect(body.installed_version).toBe(5);
    const install = await prisma.humanTemplateInstall.findUnique({
      where: {
        humanId_templateId: { humanId, templateId: tmpl.id },
      },
    });
    expect(install).not.toBeNull();
    const after = await prisma.template.findUnique({ where: { id: tmpl.id } });
    expect(after?.installCount).toBe(1);
  });
});

describe("POST /v1/templates/:id/uninstall (human)", () => {
  it("204 on success, install_count decrements", async () => {
    const owner = await seedAgent();
    const tmpl = await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Reviewer",
        publishedAt: new Date(),
        installCount: 1,
      },
    });
    const { humanId, cookie } = await seedLoggedInHuman();
    await prisma.humanTemplateInstall.create({
      data: { humanId, templateId: tmpl.id, installedVersion: 1 },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tmpl.id}/uninstall`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(204);
    const after = await prisma.template.findUnique({ where: { id: tmpl.id } });
    expect(after?.installCount).toBe(0);
    const install = await prisma.humanTemplateInstall.findUnique({
      where: { humanId_templateId: { humanId, templateId: tmpl.id } },
    });
    expect(install?.uninstalledAt).not.toBeNull();
  });

  it("204 idempotent on never-installed", async () => {
    const owner = await seedAgent();
    const tmpl = await prisma.template.create({
      data: { ownerId: owner.id, name: "t", publishedAt: new Date() },
    });
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tmpl.id}/uninstall`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(204);
  });
});

// -------------------------------------------------------------------------
// #267 PR C — install upgrade route + follow auto-advance
// -------------------------------------------------------------------------

async function seedPublishedTemplateWithV1(
  schema: object,
): Promise<{ templateId: string; ownerAgentId: string; v1Id: string }> {
  const owner = await seedAgent();
  const tmpl = await prisma.template.create({
    data: {
      ownerId: owner.id,
      name: "tpl",
      publishedAt: new Date(),
      latestVersion: 1,
    },
  });
  const v1 = await prisma.templateVersion.create({
    data: {
      templateId: tmpl.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>v1</p>",
      eventSchema: schema,
    },
  });
  return { templateId: tmpl.id, ownerAgentId: owner.id, v1Id: v1.id };
}

async function publishV2OnTemplate(
  templateId: string,
  ownerApiKey: string,
  v2Schema: object,
  v2Source = "<p>v2</p>",
): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/templates/${templateId}/versions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerApiKey}`,
      },
      body: JSON.stringify({
        type: "html-inline",
        source: v2Source,
        event_schema: v2Schema,
      }),
    }),
  );
}

describe("POST /v1/templates/:id/install — upgrade_policy (#267 PR C)", () => {
  it("defaults to pin when no body field is given", async () => {
    const { templateId } = await seedPublishedTemplateWithV1({
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const { humanId, cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${templateId}/install`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(201);
    const install = await prisma.humanTemplateInstall.findUnique({
      where: { humanId_templateId: { humanId, templateId } },
    });
    expect(install!.upgradePolicy).toBe("pin");
  });

  it("accepts upgrade_policy=follow and persists it", async () => {
    const { templateId } = await seedPublishedTemplateWithV1({
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const { humanId, cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${templateId}/install`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({ upgrade_policy: "follow" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upgrade_policy: string };
    expect(body.upgrade_policy).toBe("follow");
    const install = await prisma.humanTemplateInstall.findUnique({
      where: { humanId_templateId: { humanId, templateId } },
    });
    expect(install!.upgradePolicy).toBe("follow");
  });

  it("rejects an invalid upgrade_policy value", async () => {
    const { templateId } = await seedPublishedTemplateWithV1({
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${templateId}/install`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({ upgrade_policy: "yolo" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/templates/:id/upgrade (human, #267 PR C)", () => {
  it("happy path: re-pins the install to the new version when compatible", async () => {
    const { templateId, ownerAgentId } = await seedPublishedTemplateWithV1({
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const { humanId, cookie } = await seedLoggedInHuman();
    await prisma.humanTemplateInstall.create({
      data: {
        humanId,
        templateId,
        installedVersion: 1,
        upgradePolicy: "pin",
      },
    });
    // Publish v2 as a superset.
    const owner = await prisma.agent.findUnique({
      where: { id: ownerAgentId },
    });
    expect(owner).not.toBeNull();
    // We seeded with seedAgent() which gave us an api key, but lost the
    // reference. Mint a fresh one for the owner here.
    const ownerKey = generateApiKey();
    await prisma.agent.update({
      where: { id: ownerAgentId },
      data: { keyHash: hashKey(ownerKey), keyPrefix: keyPrefix(ownerKey) },
    });
    const v2Res = await publishV2OnTemplate(templateId, ownerKey, {
      events: {
        "feed.logged": {
          emittedBy: ["page"],
          payload: {
            type: "object",
            properties: { note: { type: "string" } },
          },
        },
      },
    });
    expect(v2Res.status).toBe(201);

    const upgradeRes = await app.fetch(
      new Request(`http://t/v1/templates/${templateId}/upgrade`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({}),
      }),
    );
    expect(upgradeRes.status).toBe(200);
    const body = (await upgradeRes.json()) as {
      installed_version: number;
      upgraded: boolean;
      breaks: unknown[];
    };
    expect(body.installed_version).toBe(2);
    expect(body.upgraded).toBe(true);
    expect(body.breaks).toEqual([]);
  });

  it("refuses 422 when the target narrows the schema (strict, default)", async () => {
    const { templateId, ownerAgentId } = await seedPublishedTemplateWithV1({
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
        "feed.unlogged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const { humanId, cookie } = await seedLoggedInHuman();
    await prisma.humanTemplateInstall.create({
      data: { humanId, templateId, installedVersion: 1 },
    });
    const ownerKey = generateApiKey();
    await prisma.agent.update({
      where: { id: ownerAgentId },
      data: { keyHash: hashKey(ownerKey), keyPrefix: keyPrefix(ownerKey) },
    });
    // v2 drops event type 'b' — narrowing.
    await publishV2OnTemplate(templateId, ownerKey, {
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${templateId}/upgrade`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("schema_incompatible_upgrade");
  });

  it("compat=force applies the upgrade even with breaks", async () => {
    const { templateId, ownerAgentId } = await seedPublishedTemplateWithV1({
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
        "feed.unlogged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const { humanId, cookie } = await seedLoggedInHuman();
    await prisma.humanTemplateInstall.create({
      data: { humanId, templateId, installedVersion: 1 },
    });
    const ownerKey = generateApiKey();
    await prisma.agent.update({
      where: { id: ownerAgentId },
      data: { keyHash: hashKey(ownerKey), keyPrefix: keyPrefix(ownerKey) },
    });
    await publishV2OnTemplate(templateId, ownerKey, {
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${templateId}/upgrade`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({ compat: "force" }),
      }),
    );
    expect(res.status).toBe(200);
    const install = await prisma.humanTemplateInstall.findUnique({
      where: { humanId_templateId: { humanId, templateId } },
    });
    expect(install!.installedVersion).toBe(2);
    expect(install!.upgradeBlockedAt).toBeNull();
  });

  it("404s if the human hasn't installed the template", async () => {
    const { templateId } = await seedPublishedTemplateWithV1({});
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(`http://t/v1/templates/${templateId}/upgrade`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("follow auto-advance on POST /v1/templates/:id/versions (#267 PR C)", () => {
  it("advances a compatible follow install to the new version", async () => {
    const { templateId, ownerAgentId } = await seedPublishedTemplateWithV1({
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const { humanId } = await seedLoggedInHuman();
    await prisma.humanTemplateInstall.create({
      data: {
        humanId,
        templateId,
        installedVersion: 1,
        upgradePolicy: "follow",
      },
    });
    const ownerKey = generateApiKey();
    await prisma.agent.update({
      where: { id: ownerAgentId },
      data: { keyHash: hashKey(ownerKey), keyPrefix: keyPrefix(ownerKey) },
    });
    // Publish v2 as a superset — the follow install should auto-advance.
    const res = await publishV2OnTemplate(templateId, ownerKey, {
      events: {
        "feed.logged": {
          emittedBy: ["page"],
          payload: { type: "object", properties: { note: { type: "string" } } },
        },
      },
    });
    expect(res.status).toBe(201);
    const install = await prisma.humanTemplateInstall.findUnique({
      where: { humanId_templateId: { humanId, templateId } },
    });
    expect(install!.installedVersion).toBe(2);
    expect(install!.upgradeBlockedAt).toBeNull();
  });

  it("blocks an incompatible follow install — sets upgradeBlockedAt + reason, leaves installedVersion", async () => {
    const { templateId, ownerAgentId } = await seedPublishedTemplateWithV1({
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
        "feed.unlogged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const { humanId } = await seedLoggedInHuman();
    await prisma.humanTemplateInstall.create({
      data: {
        humanId,
        templateId,
        installedVersion: 1,
        upgradePolicy: "follow",
      },
    });
    const ownerKey = generateApiKey();
    await prisma.agent.update({
      where: { id: ownerAgentId },
      data: { keyHash: hashKey(ownerKey), keyPrefix: keyPrefix(ownerKey) },
    });
    // v2 drops event type 'b' — narrowing.
    await publishV2OnTemplate(templateId, ownerKey, {
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const install = await prisma.humanTemplateInstall.findUnique({
      where: { humanId_templateId: { humanId, templateId } },
    });
    expect(install!.installedVersion).toBe(1);
    expect(install!.upgradeBlockedAt).not.toBeNull();
    const reason = install!.upgradeBlockedReason as Array<{
      path: string;
      message: string;
    }>;
    expect(reason.length).toBeGreaterThan(0);
    expect(reason[0]!.path).toMatch(/events\.feed\.unlogged/);
  });

  it("leaves a pin install alone when a new version is published", async () => {
    const { templateId, ownerAgentId } = await seedPublishedTemplateWithV1({
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    const { humanId } = await seedLoggedInHuman();
    await prisma.humanTemplateInstall.create({
      data: {
        humanId,
        templateId,
        installedVersion: 1,
        upgradePolicy: "pin",
      },
    });
    const ownerKey = generateApiKey();
    await prisma.agent.update({
      where: { id: ownerAgentId },
      data: { keyHash: hashKey(ownerKey), keyPrefix: keyPrefix(ownerKey) },
    });
    await publishV2OnTemplate(templateId, ownerKey, {
      events: {
        "feed.logged": {
          emittedBy: ["page"],
          payload: { type: "object", properties: { note: { type: "string" } } },
        },
      },
    });
    const install = await prisma.humanTemplateInstall.findUnique({
      where: { humanId_templateId: { humanId, templateId } },
    });
    // Still on v1; pin doesn't auto-advance.
    expect(install!.installedVersion).toBe(1);
    expect(install!.upgradeBlockedAt).toBeNull();
  });
});

describe("POST /v1/my-templates/:id/publish (human, #279 PR B)", () => {
  it("requires a login cookie", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/my-templates/x/publish", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("404s when the template is owned by an agent the caller doesn't claim", async () => {
    // Owner agent has no ownerHumanId — i.e. unclaimed / claimed by someone else.
    const owner = await seedAgent();
    const tpl = await seedTemplate(owner.id, "Foreign");
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${tpl.id}/publish`, {
        method: "POST",
        headers: { ...withCookie(cookie), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
    const after = await prisma.template.findUnique({ where: { id: tpl.id } });
    expect(after!.publishedAt).toBeNull();
  });

  it("publishes when the caller owns the agent that owns the template + persists scopes", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "mine",
        keyHash: "z".repeat(64),
        keyPrefix: "z",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const tpl = await seedTemplate(agent.id, "Reviewer");
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${tpl.id}/publish`, {
        method: "POST",
        headers: { ...withCookie(cookie), "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["read:agent", "write:pane"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      published_at: string | null;
      scopes: string[];
    };
    expect(body.published_at).not.toBeNull();
    expect(body.scopes).toEqual(["read:agent", "write:pane"]);
    const after = await prisma.template.findUnique({ where: { id: tpl.id } });
    expect(after!.publishedAt).not.toBeNull();
    expect(after!.scopes).toEqual(["read:agent", "write:pane"]);
  });

  it("rejects malformed scopes (verb:noun grammar)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "mine",
        keyHash: "z".repeat(64),
        keyPrefix: "z",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const tpl = await seedTemplate(agent.id);
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${tpl.id}/publish`, {
        method: "POST",
        headers: { ...withCookie(cookie), "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["not-a-scope"] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("preserves existing scopes when body omits the field", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "mine",
        keyHash: "z".repeat(64),
        keyPrefix: "z",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const tpl = await prisma.template.create({
      data: { ownerId: agent.id, name: "t", scopes: ["read:agent"] },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${tpl.id}/publish`, {
        method: "POST",
        headers: { ...withCookie(cookie), "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.template.findUnique({ where: { id: tpl.id } });
    expect(after!.scopes).toEqual(["read:agent"]);
  });
});

describe("POST /v1/my-templates/:id/unpublish (human, #279 PR B)", () => {
  it("requires a login cookie", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/my-templates/x/unpublish", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("404s when caller doesn't own the template's agent", async () => {
    const owner = await seedAgent();
    const tpl = await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Public foreign",
        publishedAt: new Date(),
      },
    });
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${tpl.id}/unpublish`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(404);
    const after = await prisma.template.findUnique({ where: { id: tpl.id } });
    expect(after!.publishedAt).not.toBeNull();
  });

  it("clears publishedAt when caller owns the agent", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "mine",
        keyHash: "z".repeat(64),
        keyPrefix: "z",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const tpl = await prisma.template.create({
      data: { ownerId: agent.id, name: "Pub", publishedAt: new Date() },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${tpl.id}/unpublish`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.template.findUnique({ where: { id: tpl.id } });
    expect(after!.publishedAt).toBeNull();
  });
});

describe("GET /v1/templates/catalog (agent, #279 PR C)", () => {
  it("requires an agent bearer token", async () => {
    const res = await app.fetch(new Request("http://t/v1/templates/catalog"));
    expect(res.status).toBe(401);
  });

  it("lists only published templates, no installed pill", async () => {
    const owner = await seedAgent();
    await prisma.template.create({
      data: { ownerId: owner.id, name: "Private (not published)" },
    });
    await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Public A",
        publishedAt: new Date(Date.now() - 60_000),
        installCount: 10,
      },
    });
    await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Public B",
        publishedAt: new Date(Date.now() - 30_000),
        installCount: 100,
      },
    });
    const caller = await seedAgent();
    const res = await app.fetch(
      new Request("http://t/v1/templates/catalog", {
        headers: { authorization: `Bearer ${caller.apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ name: string; install_count: number }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.items[0]!.name).toBe("Public B");
    expect(body.items[1]!.name).toBe("Public A");
    // No 'installed' field — agents don't have human installs.
    expect(body.items[0]).not.toHaveProperty("installed");
  });

  it("?q= filters across name, description, and tags (case-insensitive)", async () => {
    const owner = await seedAgent();
    await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "PR Reviewer",
        description: "Approve pull requests",
        tags: ["code"],
        publishedAt: new Date(Date.now() - 20_000),
      },
    });
    await prisma.template.create({
      data: {
        ownerId: owner.id,
        name: "Survey",
        description: "Generic ranking form",
        tags: ["forms"],
        publishedAt: new Date(Date.now() - 10_000),
      },
    });
    const caller = await seedAgent();

    const res = await app.fetch(
      new Request("http://t/v1/templates/catalog?q=pull", {
        headers: { authorization: `Bearer ${caller.apiKey}` },
      }),
    );
    const body = (await res.json()) as {
      items: Array<{ name: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]!.name).toBe("PR Reviewer");
  });
});

// ----------------------------------------------------------------------
// DELETE /v1/my-templates/:id — cookie-authed soft-delete (iter4).
// ----------------------------------------------------------------------
describe("DELETE /v1/my-templates/:id (human)", () => {
  async function seedOwnedTemplate(humanId: string) {
    const apiKey = generateApiKey();
    const agent = await prisma.agent.create({
      data: {
        name: "claimed-del",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const tmpl = await prisma.template.create({
      data: {
        ownerId: agent.id,
        name: "Deletable",
        slug: "deletable",
        latestVersion: 1,
      },
    });
    return { agentId: agent.id, templateId: tmpl.id };
  }

  it("requires auth (401 without cookie)", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/my-templates/x", { method: "DELETE" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the template isn't owned by the calling human", async () => {
    const { cookie } = await seedLoggedInHuman();
    const apiKey = generateApiKey();
    const stranger = await prisma.agent.create({
      data: {
        name: "stranger-del",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
      },
    });
    const tmpl = await prisma.template.create({
      data: {
        ownerId: stranger.id,
        name: "Stranger",
        latestVersion: 1,
      },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${tmpl.id}`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(404);
    const row = await prisma.template.findUnique({ where: { id: tmpl.id } });
    expect(row!.deletedAt).toBeNull();
  });

  it("soft-deletes an owned template + writes a DeletionLog row", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId, templateId } = await seedOwnedTemplate(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${templateId}`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(204);
    const row = await prisma.template.findUnique({ where: { id: templateId } });
    expect(row!.deletedAt).not.toBeNull();
    const logs = await prisma.deletionLog.findMany({
      where: { entityType: "template", entityId: templateId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.phase).toBe("soft_deleted");
    expect(logs[0]!.reason).toBe("human_delete");
    expect(logs[0]!.ownerHumanId).toBe(humanId);
    expect(logs[0]!.ownerAgentId).toBe(agentId);
  });

  it("is idempotent — second DELETE returns 204 without a new log row", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { templateId } = await seedOwnedTemplate(humanId);
    await app.fetch(
      new Request(`http://t/v1/my-templates/${templateId}`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${templateId}`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(204);
    const logs = await prisma.deletionLog.findMany({
      where: { entityType: "template", entityId: templateId },
    });
    expect(logs).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------
// POST /v1/my-templates/:id/launch — open a pane from an installed template.
// ----------------------------------------------------------------------
describe("POST /v1/my-templates/:id/launch (human)", () => {
  // Seeds an agent + template owned by `humanId`. The owned-launch path will
  // accept these templates without requiring an install — so tests that
  // assert "no install ⇒ 404" must seed via `seedStrangerTemplate` instead.
  async function seedClaimedTemplateForHuman(humanId: string) {
    const apiKey = generateApiKey();
    const agent = await prisma.agent.create({
      data: {
        name: "claimed",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const tmpl = await prisma.template.create({
      data: {
        ownerId: agent.id,
        name: "Launchable",
        slug: "launchable",
        latestVersion: 1,
        publishedAt: new Date(),
      },
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
    return { agentId: agent.id, templateId: tmpl.id, versionId: v1.id };
  }

  // Same shape, but owned by an unclaimed agent so the calling human has no
  // ownership claim. The launch path falls back to install-checks for these.
  async function seedStrangerTemplate() {
    const apiKey = generateApiKey();
    const agent = await prisma.agent.create({
      data: {
        name: "stranger",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
      },
    });
    const tmpl = await prisma.template.create({
      data: {
        ownerId: agent.id,
        name: "Stranger Template",
        slug: "stranger",
        latestVersion: 1,
        publishedAt: new Date(),
      },
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
    return { agentId: agent.id, templateId: tmpl.id, versionId: v1.id };
  }

  it("requires a login cookie (401 without auth)", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/my-templates/x/launch", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the template isn't owned and has no install", async () => {
    const { cookie } = await seedLoggedInHuman();
    const { templateId } = await seedStrangerTemplate();
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${templateId}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the install has been uninstalled and template isn't owned", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { templateId } = await seedStrangerTemplate();
    await prisma.humanTemplateInstall.create({
      data: {
        humanId,
        templateId,
        installedVersion: 1,
        upgradePolicy: "pin",
        uninstalledAt: new Date(),
      },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${templateId}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("launches an owned template at its latestVersion even without an install", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId, templateId, versionId } =
      await seedClaimedTemplateForHuman(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${templateId}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: "{}",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pane_id: string };
    const pane = await prisma.pane.findUnique({
      where: { id: body.pane_id },
    });
    expect(pane).not.toBeNull();
    expect(pane!.ownerHumanId).toBe(humanId);
    expect(pane!.agentId).toBe(agentId);
    expect(pane!.templateVersionId).toBe(versionId);
  });

  it("creates a pane pinned to installedVersion and returns the human URL", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId, templateId, versionId } =
      await seedClaimedTemplateForHuman(humanId);
    await prisma.humanTemplateInstall.create({
      data: {
        humanId,
        templateId,
        installedVersion: 1,
        upgradePolicy: "pin",
      },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/my-templates/${templateId}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: "{}",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      pane_id: string;
      urls: { humans: string[] };
    };
    expect(body.pane_id).toMatch(/^pan_/);
    expect(body.urls.humans).toHaveLength(1);
    expect(body.urls.humans[0]).toMatch(/\/s\/[A-Za-z0-9_-]+$/);

    // Pane row carries the human as owner so /my-panes shows it.
    const pane = await prisma.pane.findUnique({
      where: { id: body.pane_id },
    });
    expect(pane).not.toBeNull();
    expect(pane!.ownerHumanId).toBe(humanId);
    expect(pane!.agentId).toBe(agentId);
    expect(pane!.templateVersionId).toBe(versionId);
    expect(pane!.creatorKind).toBe("human");
    expect(pane!.creatorId).toBe(humanId);
  });
});

// Note: favorites moved from templates to panes in iter3. See the
// dedicated test in my-panes.e2e.test.ts.
