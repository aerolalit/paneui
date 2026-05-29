// End-to-end tests for /surfaces/:id and friends — the cookie-authed owner
// shell. These mirror the capability-token bridge (/s/:token, /s/:token/content,
// etc.) but key surfaces by id and gate them on the pane_login cookie.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import {
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
} from "../../auth/cookie.js";
import { makeDevProvider } from "../../auth/providers/dev.js";
import {
  generateApiKey,
  generateSessionId,
  hashKey,
  keyPrefix,
} from "../../keys.js";

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
      EMAIL_PROVIDER: "dev",
    }),
    prisma,
    undefined,
    undefined,
    undefined,
    makeDevProvider({ isProduction: false }),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

// Seed a logged-in human + a claimed agent owning a fresh surface. Returns
// every id the tests need plus the cookie value for Authorization-substitute.
async function seedOwnedSurface(): Promise<{
  humanId: string;
  cookie: string;
  agentId: string;
  surfaceId: string;
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

  // An agent claimed by this human; the surface's ownerHumanId is the human.
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

  // Minimal template + version so the surface has something to render.
  const template = await prisma.template.create({
    data: {
      name: "Test Template",
      ownerId: agent.id,
      slug: "test-template-" + randomBytes(4).toString("hex"),
    },
  });
  const templateVersion = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>hello from the test template</p>",
      eventSchema: {
        events: {
          "demo.feedback": {
            payload: { type: "object" },
            emittedBy: ["page"],
          },
        },
      },
    },
  });

  const surface = await prisma.surface.create({
    data: {
      id: generateSessionId(),
      agentId: agent.id,
      ownerHumanId: human.id,
      templateVersionId: templateVersion.id,
      title: "Test Surface",
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return {
    humanId: human.id,
    cookie,
    agentId: agent.id,
    surfaceId: surface.id,
  };
}

function withCookie(cookie: string): RequestInit {
  return { headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` } };
}

describe("GET /surfaces/:id", () => {
  it("returns the shell HTML for the owner", async () => {
    const { cookie, surfaceId } = await seedOwnedSurface();
    const res = await app.fetch(
      new Request(`http://t/surfaces/${surfaceId}`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // The shell embeds the surface id in its config JSON.
    expect(html).toContain(surfaceId);
    // Iframe src is the id-keyed content URL — no /s/ token anywhere.
    expect(html).toContain(`src="/surfaces/${surfaceId}/content"`);
    expect(html).not.toContain("/s/tok_");
    // Title pulls from the surface row.
    expect(html).toContain("Test Surface");
  });

  it("embeds the system-pages top nav so the owner can navigate away", async () => {
    // Without this, /surfaces/:id traps the owner — browser back is the
    // only way to reach /home, /my-surfaces, etc.
    const { cookie, surfaceId } = await seedOwnedSurface();
    const res = await app.fetch(
      new Request(`http://t/surfaces/${surfaceId}`, withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain("top-nav-tabs");
    expect(html).toContain('href="/home"');
    expect(html).toContain('href="/my-surfaces"');
    expect(html).toContain('href="/my-templates"');
    expect(html).toContain('href="/my-agents"');
    expect(html).toContain('href="/settings"');
    // The "My surfaces" tab is the active one (we're on a surface page).
    expect(html).toMatch(
      /class="top-nav-tab active"[^>]*href="\/my-surfaces"|href="\/my-surfaces"[^>]*aria-current="page"/,
    );
    // Owner's email is shown in the account block.
    expect(html).toContain("alice@example.com");
    expect(html).toContain('id="top-nav-signout"');
  });

  it("401s when no login cookie is present", async () => {
    const { surfaceId } = await seedOwnedSurface();
    const res = await app.fetch(new Request(`http://t/surfaces/${surfaceId}`));
    expect(res.status).toBe(401);
  });

  it("404s when the logged-in human is not the surface owner", async () => {
    const { surfaceId } = await seedOwnedSurface();
    // A second human, with a valid cookie of their own, must NOT see surfaces
    // they don't own.
    const other = await prisma.human.create({
      data: { email: "bob@example.com", verifiedAt: new Date() },
    });
    const otherCookie = generateLoginCookie();
    await prisma.login.create({
      data: {
        humanId: other.id,
        cookieHash: hashLoginCookie(otherCookie),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const res = await app.fetch(
      new Request(`http://t/surfaces/${surfaceId}`, withCookie(otherCookie)),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /surfaces/:id/content", () => {
  it("returns the template body wrapped with the runtime", async () => {
    const { cookie, surfaceId } = await seedOwnedSurface();
    const res = await app.fetch(
      new Request(`http://t/surfaces/${surfaceId}/content`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hello from the test template");
    // The runtime is injected into the iframe document.
    expect(html).toContain("window.pane");
  });

  it("401s without a login cookie", async () => {
    const { surfaceId } = await seedOwnedSurface();
    const res = await app.fetch(
      new Request(`http://t/surfaces/${surfaceId}/content`),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /surfaces/:id/presence", () => {
  it("returns the agent-presence JSON for the owner", async () => {
    const { cookie, surfaceId } = await seedOwnedSurface();
    const res = await app.fetch(
      new Request(
        `http://t/surfaces/${surfaceId}/presence`,
        withCookie(cookie),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    // The agent has never connected — agentLive=false, the last-*-at fields
    // are null. We don't pin agentLastUsedAt because the seed touches the
    // Agent row; just check the shape.
    expect(body).toMatchObject({
      agentLive: false,
      agentLastEventAt: null,
    });
  });
});

describe("GET /s/:token — logged-in-owner upgrade", () => {
  it("302s to /surfaces/:id when the caller is logged in as the surface owner", async () => {
    const { cookie, surfaceId } = await seedOwnedSurface();
    // Mint a participant token directly so we have a /s/:token URL to hit.
    const tok = "tok_h_" + randomBytes(32).toString("base64url");
    await prisma.participant.create({
      data: {
        surfaceId,
        kind: "human",
        identityId: "h_shared",
        tokenHash: hashKey(tok),
        tokenPrefix: keyPrefix(tok),
      },
    });
    const res = await app.fetch(
      new Request(`http://t/s/${tok}`, {
        ...withCookie(cookie),
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/surfaces/${surfaceId}`);
  });

  it("does NOT redirect when the caller is logged in as a different human", async () => {
    const { surfaceId } = await seedOwnedSurface();
    // A second logged-in human, NOT the owner.
    const other = await prisma.human.create({
      data: { email: "bob@example.com", verifiedAt: new Date() },
    });
    const otherCookie = generateLoginCookie();
    await prisma.login.create({
      data: {
        humanId: other.id,
        cookieHash: hashLoginCookie(otherCookie),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const tok = "tok_h_" + randomBytes(32).toString("base64url");
    await prisma.participant.create({
      data: {
        surfaceId,
        kind: "human",
        identityId: "h_shared",
        tokenHash: hashKey(tok),
        tokenPrefix: keyPrefix(tok),
      },
    });
    const res = await app.fetch(
      new Request(`http://t/s/${tok}`, {
        ...withCookie(otherCookie),
        redirect: "manual",
      }),
    );
    // Plain shell render, not a redirect — the share link is still the
    // intended entry for non-owners.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("does NOT redirect when there is no login cookie", async () => {
    const { surfaceId } = await seedOwnedSurface();
    const tok = "tok_h_" + randomBytes(32).toString("base64url");
    await prisma.participant.create({
      data: {
        surfaceId,
        kind: "human",
        identityId: "h_shared",
        tokenHash: hashKey(tok),
        tokenPrefix: keyPrefix(tok),
      },
    });
    const res = await app.fetch(
      new Request(`http://t/s/${tok}`, { redirect: "manual" }),
    );
    expect(res.status).toBe(200);
  });

  // Regression test for the owner-upgrade × identity-bound-participant
  // interaction. The redirect in bridge/routes.ts runs BEFORE the
  // identity-bound participant gate, so if the owner clicks a token URL that
  // happens to be bound to a *different* human, ownership wins: they get a
  // 302 to /surfaces/<id> rather than a 403 wrong_account. Without this
  // ordering the owner would be locked out of a URL they could legitimately
  // open via the clean route.
  it("redirects the owner even when the token's participant is bound to a different human", async () => {
    const { cookie, surfaceId } = await seedOwnedSurface();
    // A second human (bob), unrelated to the surface — token belongs to bob.
    const bob = await prisma.human.create({
      data: { email: "bob@example.com", verifiedAt: new Date() },
    });
    const tok = "tok_h_" + randomBytes(32).toString("base64url");
    await prisma.participant.create({
      data: {
        surfaceId,
        kind: "human",
        identityId: "h_bob",
        tokenHash: hashKey(tok),
        tokenPrefix: keyPrefix(tok),
        humanId: bob.id,
      },
    });
    // Owner (alice) hits bob's token URL while signed in as the surface owner.
    const res = await app.fetch(
      new Request(`http://t/s/${tok}`, {
        ...withCookie(cookie),
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/surfaces/${surfaceId}`);
  });
});

describe("POST /surfaces/:id/ws-ticket", () => {
  it("mints a ticket for the owner and lazy-creates their Participant row", async () => {
    const { cookie, surfaceId, humanId } = await seedOwnedSurface();

    // No participant rows yet — proves we're lazy-minting.
    const before = await prisma.participant.findMany({
      where: { surfaceId },
    });
    expect(before.length).toBe(0);

    const res = await app.fetch(
      new Request(`http://t/surfaces/${surfaceId}/ws-ticket`, {
        method: "POST",
        ...withCookie(cookie),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThan(20);

    // The owner's identity-bound participant exists after the call.
    const after = await prisma.participant.findMany({
      where: { surfaceId },
    });
    expect(after.length).toBe(1);
    expect(after[0]!).toMatchObject({
      kind: "human",
      humanId,
      identityId: "h_owner",
    });
  });

  it("reuses the same identity-id on a second call", async () => {
    const { cookie, surfaceId } = await seedOwnedSurface();
    const r1 = await app.fetch(
      new Request(`http://t/surfaces/${surfaceId}/ws-ticket`, {
        method: "POST",
        ...withCookie(cookie),
      }),
    );
    expect(r1.status).toBe(201);
    const r2 = await app.fetch(
      new Request(`http://t/surfaces/${surfaceId}/ws-ticket`, {
        method: "POST",
        ...withCookie(cookie),
      }),
    );
    expect(r2.status).toBe(201);
    // Still exactly one participant — the second call reused it.
    const rows = await prisma.participant.findMany({
      where: { surfaceId },
    });
    expect(rows.length).toBe(1);
  });

  it("never mints duplicate owner participants under concurrent calls", async () => {
    // Race fix regression: two concurrent ws-ticket calls (e.g. two tabs the
    // owner opened at once) must collide on the (surfaceId, identityId)
    // unique constraint and resolve to a single Participant row. Without
    // that, the lazy-mint's findFirst+create can race into duplicates and
    // the owner's identity-id flips between rows on subsequent reconnects.
    const { cookie, surfaceId } = await seedOwnedSurface();
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(() =>
        app.fetch(
          new Request(`http://t/surfaces/${surfaceId}/ws-ticket`, {
            method: "POST",
            ...withCookie(cookie),
          }),
        ),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);
    const rows = await prisma.participant.findMany({
      where: { surfaceId, kind: "human" },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.identityId).toBe("h_owner");
  });

  it("returns 410 for a closed surface", async () => {
    const { cookie, surfaceId } = await seedOwnedSurface();
    await prisma.surface.update({
      where: { id: surfaceId },
      data: { status: "closed" },
    });
    const res = await app.fetch(
      new Request(`http://t/surfaces/${surfaceId}/ws-ticket`, {
        method: "POST",
        ...withCookie(cookie),
      }),
    );
    expect(res.status).toBe(410);
  });
});
