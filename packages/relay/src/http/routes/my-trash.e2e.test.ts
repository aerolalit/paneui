// #309 — /v1/my-trash routes (cookie-authed mirror of /v1/trash).
//
// Mirrors the agent-side trash.e2e.test.ts (#306) but with login-cookie
// auth. The ownership rules are different: a human can see and act on:
//   - panes whose ownerHumanId is theirs
//   - panes owned by an agent whose ownerHumanId is theirs (claimed agents)
//   - templates whose owning agent has ownerHumanId === theirs

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import { hashKey, keyPrefix } from "../../keys.js";
import { seedPaneRow } from "../../test-helpers/seed.js";
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

async function seedLoggedInHuman(): Promise<{
  humanId: string;
  cookie: string;
}> {
  const human = await prisma.human.create({
    data: {
      email: `h-${randomBytes(4).toString("hex")}@example.com`,
      verifiedAt: new Date(),
    },
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

async function seedClaimedAgent(humanId: string): Promise<string> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const a = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      ownerHumanId: humanId,
      claimedAt: new Date(),
    },
  });
  return a.id;
}

async function seedTrashedPane(opts: {
  agentId: string;
  ownerHumanId?: string;
}): Promise<string> {
  const { paneId } = await seedPaneRow(prisma, {
    agentId: opts.agentId,
    status: "open",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await prisma.pane.update({
    where: { id: paneId },
    data: {
      deletedAt: new Date(),
      ownerHumanId: opts.ownerHumanId ?? null,
    },
  });
  return paneId;
}

async function seedTrashedTemplate(ownerAgentId: string): Promise<string> {
  const t = await prisma.template.create({
    data: {
      ownerId: ownerAgentId,
      name: `T-${randomBytes(4).toString("hex")}`,
      latestVersion: 1,
      deletedAt: new Date(),
    },
  });
  return t.id;
}

describe("GET /v1/my-trash", () => {
  it("requires a login cookie (401)", async () => {
    const res = await app.fetch(new Request("http://t/v1/my-trash"));
    expect(res.status).toBe(401);
  });

  it("lists trashed panes owned via claimed agent + ones the human owns directly", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const myAgent = await seedClaimedAgent(humanId);
    const claimedAgentPane = await seedTrashedPane({ agentId: myAgent });
    const directOwnerPane = await seedTrashedPane({
      agentId: myAgent,
      ownerHumanId: humanId,
    });

    // Foreign agent + foreign pane — must NOT appear.
    const foreignApiKey = "pane_" + randomBytes(16).toString("hex");
    const foreignAgent = await prisma.agent.create({
      data: {
        name: "other",
        keyHash: hashKey(foreignApiKey),
        keyPrefix: keyPrefix(foreignApiKey),
      },
    });
    const foreignPane = await seedTrashedPane({ agentId: foreignAgent.id });

    const res = await app.fetch(
      new Request("http://t/v1/my-trash", {
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { panes: { pane_id: string }[] };
    const ids = body.panes.map((p) => p.pane_id);
    expect(ids).toContain(claimedAgentPane);
    expect(ids).toContain(directOwnerPane);
    expect(ids).not.toContain(foreignPane);
  });
});

describe("POST /v1/my-trash/panes/:id/restore", () => {
  it("clears deletedAt + writes a DeletionLog audit row", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedClaimedAgent(humanId);
    const paneId = await seedTrashedPane({ agentId });

    const res = await app.fetch(
      new Request(`http://t/v1/my-trash/panes/${paneId}/restore`, {
        method: "POST",
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(res.status).toBe(200);
    const row = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(row?.deletedAt).toBeNull();
    const audit = await prisma.deletionLog.findFirst({
      where: { entityType: "pane", entityId: paneId, phase: "restored" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.reason).toBe("user_action");
  });

  it("404s on a foreign pane (no cross-human leakage)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const foreignApiKey = "pane_" + randomBytes(16).toString("hex");
    const foreignAgent = await prisma.agent.create({
      data: {
        name: "x",
        keyHash: hashKey(foreignApiKey),
        keyPrefix: keyPrefix(foreignApiKey),
      },
    });
    const foreignPane = await seedTrashedPane({ agentId: foreignAgent.id });

    const res = await app.fetch(
      new Request(`http://t/v1/my-trash/panes/${foreignPane}/restore`, {
        method: "POST",
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s on a live (non-trashed) pane", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedClaimedAgent(humanId);
    const { paneId } = await seedPaneRow(prisma, {
      agentId,
      status: "open",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.fetch(
      new Request(`http://t/v1/my-trash/panes/${paneId}/restore`, {
        method: "POST",
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/my-trash/panes/:id", () => {
  it("permanently deletes a trashed pane + writes hard_deleted DeletionLog", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedClaimedAgent(humanId);
    const paneId = await seedTrashedPane({ agentId });

    const res = await app.fetch(
      new Request(`http://t/v1/my-trash/panes/${paneId}`, {
        method: "DELETE",
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(res.status).toBe(204);
    expect(await prisma.pane.findUnique({ where: { id: paneId } })).toBeNull();
    const audit = await prisma.deletionLog.findFirst({
      where: { entityType: "pane", entityId: paneId, phase: "hard_deleted" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.reason).toBe("user_immediate");
  });
});

describe("POST /v1/my-trash/templates/:id/restore", () => {
  it("restores a trashed template the human owns via a claimed agent", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedClaimedAgent(humanId);
    const templateId = await seedTrashedTemplate(agentId);

    const res = await app.fetch(
      new Request(`http://t/v1/my-trash/templates/${templateId}/restore`, {
        method: "POST",
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(res.status).toBe(200);
    const row = await prisma.template.findUnique({
      where: { id: templateId },
    });
    expect(row?.deletedAt).toBeNull();
  });
});

describe("DELETE /v1/my-trash/templates/:id", () => {
  it("permanently deletes a trashed template", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedClaimedAgent(humanId);
    const templateId = await seedTrashedTemplate(agentId);

    const res = await app.fetch(
      new Request(`http://t/v1/my-trash/templates/${templateId}`, {
        method: "DELETE",
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(res.status).toBe(204);
    expect(
      await prisma.template.findUnique({ where: { id: templateId } }),
    ).toBeNull();
  });
});

describe("GET /trash (HTML page)", () => {
  it("redirects unauthenticated visitors to a login prompt (200 with login HTML)", async () => {
    const res = await app.fetch(new Request("http://t/trash"));
    expect(res.status).toBe(200);
    const html = await res.text();
    // Logged-out body uses the shared loggedOutPrompt — content varies but
    // must NOT include trash management UI.
    expect(html).not.toContain('data-act="restore-pane"');
  });

  it("renders the trash UI for a logged-in human with trashed rows", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedClaimedAgent(humanId);
    const paneId = await seedTrashedPane({ agentId });
    const templateId = await seedTrashedTemplate(agentId);

    const res = await app.fetch(
      new Request("http://t/trash", { headers: { ...withCookie(cookie) } }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(paneId);
    expect(html).toContain(templateId);
    expect(html).toContain('data-act="restore-pane"');
    expect(html).toContain('data-act="purge-pane"');
    expect(html).toContain('data-act="restore-template"');
    expect(html).toContain('data-act="purge-template"');
  });

  it("renders the empty-state when nothing is in trash", async () => {
    const { cookie } = await seedLoggedInHuman();

    const res = await app.fetch(
      new Request("http://t/trash", { headers: { ...withCookie(cookie) } }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Nothing in trash");
  });
});

describe("/my-* show_deleted toggle (#310)", () => {
  it("/my-panes hides trashed panes by default, shows them with ?show_deleted=true", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedClaimedAgent(humanId);
    const trashedId = await seedTrashedPane({
      agentId,
      ownerHumanId: humanId,
    });

    const hideRes = await app.fetch(
      new Request("http://t/my-panes", { headers: { ...withCookie(cookie) } }),
    );
    const hideHtml = await hideRes.text();
    expect(hideHtml).not.toContain(trashedId);
    expect(hideHtml).toContain("Show trashed");

    const showRes = await app.fetch(
      new Request("http://t/my-panes?show_deleted=true", {
        headers: { ...withCookie(cookie) },
      }),
    );
    const showHtml = await showRes.text();
    expect(showHtml).toContain(trashedId);
    expect(showHtml).toContain("Hide trashed");
    // Trashed pill is rendered.
    expect(showHtml).toContain(">Trashed<");
  });

  it("/my-templates honours ?show_deleted=true", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedClaimedAgent(humanId);
    const trashedId = await seedTrashedTemplate(agentId);

    const hideRes = await app.fetch(
      new Request("http://t/my-templates", {
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(await hideRes.text()).not.toContain(trashedId);

    const showRes = await app.fetch(
      new Request("http://t/my-templates?show_deleted=true", {
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(await showRes.text()).toContain(trashedId);
  });

  it("/my-agents honours ?show_deleted=true", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    // Seed a trashed agent for this human.
    const trashedApiKey = "pane_" + randomBytes(16).toString("hex");
    const trashedAgent = await prisma.agent.create({
      data: {
        name: "trashed",
        keyHash: hashKey(trashedApiKey),
        keyPrefix: keyPrefix(trashedApiKey),
        ownerHumanId: humanId,
        claimedAt: new Date(),
        deletedAt: new Date(),
      },
    });

    const hideRes = await app.fetch(
      new Request("http://t/my-agents", {
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(await hideRes.text()).not.toContain(trashedAgent.id);

    const showRes = await app.fetch(
      new Request("http://t/my-agents?show_deleted=true", {
        headers: { ...withCookie(cookie) },
      }),
    );
    expect(await showRes.text()).toContain(trashedAgent.id);
  });
});
