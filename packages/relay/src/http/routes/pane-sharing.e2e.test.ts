// End-to-end tests for the agent-authed pane-sharing surface:
//   PATCH  /v1/panes/:id/visibility
//   GET    /v1/panes/:id/grants
//   POST   /v1/panes/:id/grants
//   DELETE /v1/panes/:id/grants/:gid
// plus GET /v1/self/recents (cookie-authed).

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
  hashKey,
  keyPrefix,
  generatePaneId,
} from "../../keys.js";
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

// Seed an agent (owned by a human), a template/version, and one pane.
async function seedPane(): Promise<{
  humanId: string;
  cookie: string;
  agentKey: string;
  otherAgentKey: string;
  paneId: string;
}> {
  const human = await prisma.human.create({
    data: { email: "alice@example.com", verifiedAt: new Date() },
  });
  const cookie = generateLoginCookie();
  await prisma.login.create({
    data: {
      humanId: human.id,
      cookieHash: hashLoginCookie(cookie),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const agentKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      keyHash: hashKey(agentKey),
      keyPrefix: keyPrefix(agentKey),
      name: "test-agent",
      ownerHumanId: human.id,
      claimedAt: new Date(),
    },
  });

  // A second, unrelated agent (different human) for cross-tenant checks.
  const otherKey = generateApiKey();
  const otherHuman = await prisma.human.create({
    data: { email: "mallory@example.com", verifiedAt: new Date() },
  });
  await prisma.agent.create({
    data: {
      keyHash: hashKey(otherKey),
      keyPrefix: keyPrefix(otherKey),
      name: "other-agent",
      ownerHumanId: otherHuman.id,
      claimedAt: new Date(),
    },
  });

  const template = await prisma.template.create({
    data: {
      name: "T",
      ownerId: agent.id,
      slug: "t-" + randomBytes(4).toString("hex"),
    },
  });
  const tv = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>hi</p>",
      eventSchema: { events: {} },
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: generatePaneId(),
      agentId: agent.id,
      ownerHumanId: human.id,
      templateVersionId: tv.id,
      title: "Test Pane",
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return {
    humanId: human.id,
    cookie,
    agentKey,
    otherAgentKey: otherKey,
    paneId: pane.id,
  };
}

function agentHeaders(key: string): HeadersInit {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

describe("PATCH /v1/panes/:id/visibility", () => {
  it("sets accessMode for the owning agent (all three modes)", async () => {
    const { agentKey, paneId } = await seedPane();
    for (const mode of ["invite_only", "link", "public"] as const) {
      const res = await app.fetch(
        new Request(`http://t/v1/panes/${paneId}/visibility`, {
          method: "PATCH",
          headers: agentHeaders(agentKey),
          body: JSON.stringify({ access_mode: mode }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.access_mode).toBe(mode);
      const row = await prisma.pane.findUnique({ where: { id: paneId } });
      expect(row?.accessMode).toBe(mode);
    }
  });

  it("rejects an invalid access_mode (400)", async () => {
    const { agentKey, paneId } = await seedPane();
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/visibility`, {
        method: "PATCH",
        headers: agentHeaders(agentKey),
        body: JSON.stringify({ access_mode: "everyone" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing access_mode (400)", async () => {
    const { agentKey, paneId } = await seedPane();
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/visibility`, {
        method: "PATCH",
        headers: agentHeaders(agentKey),
        body: JSON.stringify({ is_public: true }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404/forbidden for an agent that doesn't own the pane", async () => {
    const { otherAgentKey, paneId } = await seedPane();
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/visibility`, {
        method: "PATCH",
        headers: agentHeaders(otherAgentKey),
        body: JSON.stringify({ access_mode: "public" }),
      }),
    );
    // Cross-human pane is forbidden (403) per assertPaneInScope.
    expect([403, 404]).toContain(res.status);
    const row = await prisma.pane.findUnique({ where: { id: paneId } });
    // Untouched — still the default.
    expect(row?.accessMode).toBe("link");
  });
});

describe("grants CRUD", () => {
  it("creates a grant with the default participant role and lists it", async () => {
    const { agentKey, paneId } = await seedPane();
    const create = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/grants`, {
        method: "POST",
        headers: agentHeaders(agentKey),
        body: JSON.stringify({ email: "Bob@Example.com" }),
      }),
    );
    expect(create.status).toBe(201);
    const grant = await create.json();
    expect(grant.role).toBe("participant");
    // Email normalised to lower-case.
    expect(grant.invite_email).toBe("bob@example.com");
    // Pending — bob hasn't logged in.
    expect(grant.human_id).toBeNull();
    expect(grant.accepted_at).toBeNull();

    const list = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/grants`, {
        headers: agentHeaders(agentKey),
      }),
    );
    const listed = await list.json();
    expect(listed.access_mode).toBe("link");
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].invite_email).toBe("bob@example.com");
  });

  it("accepts an explicit viewer role", async () => {
    const { agentKey, paneId } = await seedPane();
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/grants`, {
        method: "POST",
        headers: agentHeaders(agentKey),
        body: JSON.stringify({ email: "v@example.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).role).toBe("viewer");
  });

  it("upserts by email (re-invite updates role in place)", async () => {
    const { agentKey, paneId } = await seedPane();
    await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/grants`, {
        method: "POST",
        headers: agentHeaders(agentKey),
        body: JSON.stringify({ email: "c@example.com", role: "participant" }),
      }),
    );
    await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/grants`, {
        method: "POST",
        headers: agentHeaders(agentKey),
        body: JSON.stringify({ email: "c@example.com", role: "viewer" }),
      }),
    );
    const grants = await prisma.paneGrant.findMany({
      where: { paneId, inviteEmail: "c@example.com" },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.role).toBe("viewer");
  });

  it("rejects an invalid role (400)", async () => {
    const { agentKey, paneId } = await seedPane();
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/grants`, {
        method: "POST",
        headers: agentHeaders(agentKey),
        body: JSON.stringify({ email: "x@example.com", role: "admin" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("delete is idempotent", async () => {
    const { agentKey, paneId } = await seedPane();
    const created = await (
      await app.fetch(
        new Request(`http://t/v1/panes/${paneId}/grants`, {
          method: "POST",
          headers: agentHeaders(agentKey),
          body: JSON.stringify({ email: "d@example.com" }),
        }),
      )
    ).json();

    const del1 = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/grants/${created.id}`, {
        method: "DELETE",
        headers: agentHeaders(agentKey),
      }),
    );
    expect(del1.status).toBe(204);
    // Second delete still 204.
    const del2 = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/grants/${created.id}`, {
        method: "DELETE",
        headers: agentHeaders(agentKey),
      }),
    );
    expect(del2.status).toBe(204);
    expect(await prisma.paneGrant.count({ where: { paneId } })).toBe(0);
  });

  it("only the owning agent can mutate grants", async () => {
    const { otherAgentKey, paneId } = await seedPane();
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/grants`, {
        method: "POST",
        headers: agentHeaders(otherAgentKey),
        body: JSON.stringify({ email: "e@example.com" }),
      }),
    );
    expect([403, 404]).toContain(res.status);
    expect(await prisma.paneGrant.count({ where: { paneId } })).toBe(0);
  });
});

describe("GET /v1/self/recents", () => {
  it("requires a login cookie", async () => {
    const res = await app.fetch(new Request("http://t/v1/self/recents"));
    expect(res.status).toBe(401);
  });

  it("returns viewed panes newest-first; opening records a view", async () => {
    const { cookie, paneId } = await seedPane();

    // Initially empty.
    const empty = await app.fetch(
      new Request("http://t/v1/self/recents", {
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect((await empty.json()).items).toHaveLength(0);

    // Owner opens their pane via the owner shell — records a view.
    await app.fetch(
      new Request(`http://t/panes/${paneId}`, {
        headers: {
          cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
          accept: "text/html",
        },
      }),
    );

    // Allow the fire-and-forget recordView to flush.
    await new Promise((r) => setTimeout(r, 50));

    const after = await app.fetch(
      new Request("http://t/v1/self/recents", {
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    const body = await after.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0].pane_id).toBe(paneId);
    expect(body.items[0].title).toBe("Test Pane");
    expect(typeof body.items[0].last_viewed_at).toBe("string");
    // access_mode drives the visibility icon on the Home recently-viewed cards.
    expect(body.items[0].access_mode).toBe("link");
    // owned gates the Delete action in the recents ⋯ menu — true here since the
    // viewing human owns the seeded pane.
    expect(body.items[0].owned).toBe(true);
  });

  it("reports owned=false for a viewed pane the human does not own", async () => {
    const { cookie } = await seedPane();

    // A second human + agent own a separate, link-shared pane (not Alice's).
    const otherHuman = await prisma.human.create({
      data: { email: "bob@example.com", verifiedAt: new Date() },
    });
    const otherAgent = await prisma.agent.create({
      data: {
        keyHash: hashKey(generateApiKey()),
        keyPrefix: keyPrefix(generateApiKey()),
        name: "bob-agent",
        ownerHumanId: otherHuman.id,
        claimedAt: new Date(),
      },
    });
    const tpl = await prisma.template.create({
      data: {
        name: "T2",
        ownerId: otherAgent.id,
        slug: "t2-" + randomBytes(4).toString("hex"),
      },
    });
    const tv = await prisma.templateVersion.create({
      data: {
        templateId: tpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p>hi</p>",
        eventSchema: { events: {} },
      },
    });
    const otherPaneId = generatePaneId();
    await prisma.pane.create({
      data: {
        id: otherPaneId,
        agentId: otherAgent.id,
        ownerHumanId: otherHuman.id,
        templateVersionId: tv.id,
        title: "Bob Pane",
        status: "open",
        accessMode: "link",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    // Alice opens it via the public link mount — records a view for her.
    await app.fetch(
      new Request(`http://t/p/${otherPaneId}`, {
        headers: {
          cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
          accept: "text/html",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const after = await app.fetch(
      new Request("http://t/v1/self/recents", {
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    const body = await after.json();
    const item = body.items.find(
      (i: { pane_id: string }) => i.pane_id === otherPaneId,
    );
    expect(item).toBeDefined();
    expect(item.owned).toBe(false);
  });
});

describe("DELETE /v1/self/recents/:paneId (hide from recents)", () => {
  it("requires a login cookie", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/self/recents/pan_whatever", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("forgets the view row so the pane drops out of recents", async () => {
    const { cookie, paneId } = await seedPane();

    // Record a view, confirm it shows.
    await app.fetch(
      new Request(`http://t/panes/${paneId}`, {
        headers: {
          cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
          accept: "text/html",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const before = await (
      await app.fetch(
        new Request("http://t/v1/self/recents", {
          headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
        }),
      )
    ).json();
    expect(
      before.items.some((i: { pane_id: string }) => i.pane_id === paneId),
    ).toBe(true);

    // Hide it.
    const hide = await app.fetch(
      new Request(`http://t/v1/self/recents/${paneId}`, {
        method: "DELETE",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(hide.status).toBe(204);

    // Gone from recents; the pane itself is untouched.
    const after = await (
      await app.fetch(
        new Request("http://t/v1/self/recents", {
          headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
        }),
      )
    ).json();
    expect(
      after.items.some((i: { pane_id: string }) => i.pane_id === paneId),
    ).toBe(false);
    expect(
      await prisma.pane.findUnique({ where: { id: paneId } }),
    ).not.toBeNull();
  });

  it("is idempotent — 204 when there is no view row to hide", async () => {
    const { cookie, paneId } = await seedPane();
    const res = await app.fetch(
      new Request(`http://t/v1/self/recents/${paneId}`, {
        method: "DELETE",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(204);
  });
});
