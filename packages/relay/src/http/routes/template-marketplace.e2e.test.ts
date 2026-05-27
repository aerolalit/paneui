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
        body: JSON.stringify({ scopes: ["read:surfaces", "write:events"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      published_at: string | null;
      scopes: string[];
    };
    expect(body.published_at).not.toBeNull();
    expect(body.scopes).toEqual(["read:surfaces", "write:events"]);
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
        scopes: ["read:surfaces"] as unknown as object,
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
