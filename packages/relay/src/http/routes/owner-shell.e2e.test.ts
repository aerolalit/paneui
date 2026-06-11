// End-to-end tests for /panes/:id and friends — the cookie-authed owner
// shell. These mirror the capability-token bridge (/s/:token, /s/:token/content,
// etc.) but key panes by id and gate them on the pane_login cookie.

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
  generatePaneId,
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

// Seed a logged-in human + a claimed agent owning a fresh pane. Returns
// every id the tests need plus the cookie value for Authorization-substitute.
async function seedOwnedPane(): Promise<{
  humanId: string;
  cookie: string;
  agentId: string;
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

  // An agent claimed by this human; the pane's ownerHumanId is the human.
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

  // Minimal template + version so the pane has something to render.
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

  const pane = await prisma.pane.create({
    data: {
      id: generatePaneId(),
      agentId: agent.id,
      ownerHumanId: human.id,
      templateVersionId: templateVersion.id,
      title: "Test Pane",
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return {
    humanId: human.id,
    cookie,
    agentId: agent.id,
    paneId: pane.id,
  };
}

function withCookie(cookie: string): RequestInit {
  return { headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` } };
}

describe("GET /panes/:id", () => {
  it("returns the shell HTML for the owner", async () => {
    const { cookie, paneId } = await seedOwnedPane();
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // The shell embeds the pane id in its config JSON.
    expect(html).toContain(paneId);
    // Iframe src is the id-keyed content URL — no /s/ token anywhere.
    expect(html).toContain(`src="/panes/${paneId}/content"`);
    expect(html).not.toContain("/s/tok_");
    // Title pulls from the pane row.
    expect(html).toContain("Test Pane");
  });

  it("renders the slim account bar without system-page tabs", async () => {
    // The pane viewer is a focused single-pane surface: it shows the account
    // bar (brand + presence + Share + sign out) but intentionally omits the
    // Home / My panes / My templates / ... tab strip. The brand logo links
    // back to /home, so the owner still has a way out.
    const { cookie, paneId } = await seedOwnedPane();
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}`, withCookie(cookie)),
    );
    const html = await res.text();
    // The system-pages tab strip is gone.
    expect(html).not.toContain("top-nav-tabs");
    expect(html).not.toContain('href="/my-panes"');
    expect(html).not.toContain('href="/my-templates"');
    expect(html).not.toContain('href="/my-agents"');
    expect(html).not.toContain('href="/settings"');
    // The brand still links back to /home — the way out.
    expect(html).toContain('href="/home"');
    // The owner's email is no longer shown in the account block; a Share button
    // (which opens the in-page share dialog) replaces it. Sign out stays.
    expect(html).not.toContain("alice@example.com");
    expect(html).toContain('id="top-nav-share"');
    expect(html).toContain('id="share-modal"');
    expect(html).toContain('id="top-nav-signout"');
    // Presence pills live in the top nav (connection + agent status). The
    // standalone dark header (class="brand-name") is gone.
    expect(html).toContain('id="dot"');
    expect(html).toContain('id="status"');
    expect(html).toContain('id="agent-dot"');
    expect(html).toContain('id="agent-status"');
    expect(html).not.toContain('class="brand-name"');
  });

  it("embedded=1 drops the top-nav and relaxes the anti-framing headers", async () => {
    // The owner /home SPA frames this same-origin shell (in-SPA pane view).
    // embedded=1 must (a) allow same-origin framing and (b) drop the owner
    // top-nav so chrome isn't doubled up. Standalone loads stay locked down.
    const { cookie, paneId } = await seedOwnedPane();

    const standalone = await app.fetch(
      new Request(`http://t/panes/${paneId}`, withCookie(cookie)),
    );
    expect(standalone.headers.get("x-frame-options")).toBe("DENY");
    expect(standalone.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );

    const embedded = await app.fetch(
      new Request(`http://t/panes/${paneId}?embedded=1`, withCookie(cookie)),
    );
    expect(embedded.status).toBe(200);
    // Framing allowed for same-origin (the /home shell), nothing else.
    expect(embedded.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const csp = embedded.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    // Top-nav account bar is gone (the SPA supplies its own chrome).
    const html = await embedded.text();
    expect(html).not.toContain('id="top-nav-share"');
    expect(html).not.toContain('id="top-nav-signout"');
    // The pane still works: same content iframe + cfg as the standalone load.
    expect(html).toContain(`src="/panes/${paneId}/content"`);
  });

  it("401s when no login cookie is present (API / curl path — no Accept header)", async () => {
    const { paneId } = await seedOwnedPane();
    const res = await app.fetch(new Request(`http://t/panes/${paneId}`));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("302s an anonymous browser to /login?return=… (#269)", async () => {
    // Previously a browser hitting /panes/:id cold got a raw JSON 401,
    // which renders as a wall of text on the page. The bridge already
    // handles this for identity-bound participants — match the behavior on
    // the owner-shell mount.
    const { paneId } = await seedOwnedPane();
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}`, {
        headers: { Accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("/login?return=")).toBe(true);
    expect(decodeURIComponent(loc.slice("/login?return=".length))).toBe(
      `/panes/${paneId}`,
    );
  });

  it("302s on an expired cookie too — not just absent ones", async () => {
    // An expired pane_login cookie is structurally the same problem as no
    // cookie. Browser nav with such a cookie should still bounce, not show
    // a JSON 401 wall.
    const { paneId } = await seedOwnedPane();
    // Plant a login row that's already expired.
    const expiredHuman = await prisma.human.create({
      data: { email: "expired@example.com", verifiedAt: new Date() },
    });
    const expiredCookie = generateLoginCookie();
    await prisma.login.create({
      data: {
        humanId: expiredHuman.id,
        cookieHash: hashLoginCookie(expiredCookie),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}`, {
        headers: {
          Accept: "text/html",
          cookie: `${LOGIN_COOKIE_NAME}=${expiredCookie}`,
        },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/login?return=");
  });

  it("still 401s a POST (xhr from a stale page) even with Accept: text/html", async () => {
    // Only GETs are mis-clicks worth redirecting; a POST to /ws-ticket
    // without a cookie is an XHR that needs the structured error to
    // branch on. The middleware preserves that.
    const { paneId } = await seedOwnedPane();
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/ws-ticket`, {
        method: "POST",
        headers: { Accept: "text/html" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("404s when the logged-in human is not the pane owner", async () => {
    const { paneId } = await seedOwnedPane();
    // A second human, with a valid cookie of their own, must NOT see panes
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
      new Request(`http://t/panes/${paneId}`, withCookie(otherCookie)),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /panes/:id/content", () => {
  it("returns the template body wrapped with the runtime", async () => {
    const { cookie, paneId } = await seedOwnedPane();
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/content`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hello from the test template");
    // The runtime is injected into the iframe document.
    expect(html).toContain("window.pane");
  });

  it("401s without a login cookie", async () => {
    const { paneId } = await seedOwnedPane();
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/content`),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /panes/:id/presence", () => {
  it("returns the agent-presence JSON for the owner", async () => {
    const { cookie, paneId } = await seedOwnedPane();
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/presence`, withCookie(cookie)),
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
  it("302s to /panes/:id when the caller is logged in as the pane owner", async () => {
    const { cookie, paneId } = await seedOwnedPane();
    // Mint a participant token directly so we have a /s/:token URL to hit.
    const tok = "tok_h_" + randomBytes(32).toString("base64url");
    await prisma.participant.create({
      data: {
        paneId,
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
    expect(res.headers.get("location")).toBe(`/panes/${paneId}`);
  });

  it("does NOT redirect when the caller is logged in as a different human", async () => {
    const { paneId } = await seedOwnedPane();
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
        paneId,
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
    const { paneId } = await seedOwnedPane();
    const tok = "tok_h_" + randomBytes(32).toString("base64url");
    await prisma.participant.create({
      data: {
        paneId,
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
  // 302 to /panes/<id> rather than a 403 wrong_account. Without this
  // ordering the owner would be locked out of a URL they could legitimately
  // open via the clean route.
  it("redirects the owner even when the token's participant is bound to a different human", async () => {
    const { cookie, paneId } = await seedOwnedPane();
    // A second human (bob), unrelated to the pane — token belongs to bob.
    const bob = await prisma.human.create({
      data: { email: "bob@example.com", verifiedAt: new Date() },
    });
    const tok = "tok_h_" + randomBytes(32).toString("base64url");
    await prisma.participant.create({
      data: {
        paneId,
        kind: "human",
        identityId: "h_bob",
        tokenHash: hashKey(tok),
        tokenPrefix: keyPrefix(tok),
        humanId: bob.id,
      },
    });
    // Owner (alice) hits bob's token URL while signed in as the pane owner.
    const res = await app.fetch(
      new Request(`http://t/s/${tok}`, {
        ...withCookie(cookie),
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/panes/${paneId}`);
  });
});

describe("POST /panes/:id/ws-ticket", () => {
  it("mints a ticket for the owner and lazy-creates their Participant row", async () => {
    const { cookie, paneId, humanId } = await seedOwnedPane();

    // No participant rows yet — proves we're lazy-minting.
    const before = await prisma.participant.findMany({
      where: { paneId },
    });
    expect(before.length).toBe(0);

    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/ws-ticket`, {
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
      where: { paneId },
    });
    expect(after.length).toBe(1);
    expect(after[0]!).toMatchObject({
      kind: "human",
      humanId,
      identityId: "h_owner",
    });
  });

  it("reuses the same identity-id on a second call", async () => {
    const { cookie, paneId } = await seedOwnedPane();
    const r1 = await app.fetch(
      new Request(`http://t/panes/${paneId}/ws-ticket`, {
        method: "POST",
        ...withCookie(cookie),
      }),
    );
    expect(r1.status).toBe(201);
    const r2 = await app.fetch(
      new Request(`http://t/panes/${paneId}/ws-ticket`, {
        method: "POST",
        ...withCookie(cookie),
      }),
    );
    expect(r2.status).toBe(201);
    // Still exactly one participant — the second call reused it.
    const rows = await prisma.participant.findMany({
      where: { paneId },
    });
    expect(rows.length).toBe(1);
  });

  it("never mints duplicate owner participants under concurrent calls", async () => {
    // Race fix regression: two concurrent ws-ticket calls (e.g. two tabs the
    // owner opened at once) must collide on the (paneId, identityId)
    // unique constraint and resolve to a single Participant row. Without
    // that, the lazy-mint's findFirst+create can race into duplicates and
    // the owner's identity-id flips between rows on subsequent reconnects.
    const { cookie, paneId } = await seedOwnedPane();
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(() =>
        app.fetch(
          new Request(`http://t/panes/${paneId}/ws-ticket`, {
            method: "POST",
            ...withCookie(cookie),
          }),
        ),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);
    const rows = await prisma.participant.findMany({
      where: { paneId, kind: "human" },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.identityId).toBe("h_owner");
  });

  it("returns 410 for a closed pane", async () => {
    const { cookie, paneId } = await seedOwnedPane();
    await prisma.pane.update({
      where: { id: paneId },
      data: { status: "closed" },
    });
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/ws-ticket`, {
        method: "POST",
        ...withCookie(cookie),
      }),
    );
    expect(res.status).toBe(410);
  });
});

describe("GET /home — in-SPA pane view", () => {
  it("renders the pane-view mount point and the client JS parses", async () => {
    const { cookie } = await seedOwnedPane();
    const res = await app.fetch(
      new Request(`http://t/home`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    // The in-SPA pane viewer mount point + its chrome are present.
    expect(html).toContain('data-view="pane"');
    expect(html).toContain('id="pane-host-frame"');
    expect(html).toContain('id="pane-host-back"');
    // The iframe starts blank — a pane is only mounted on open.
    expect(html).toContain('src="about:blank"');

    // tsc does NOT typecheck the SHELL_JS string body, so a syntax error in the
    // inline client JS would otherwise reach the browser. Extract the bundle
    // (the <script> carrying the SPA logic) and compile it with new Function —
    // this parses without executing, throwing on any syntax error.
    const scripts = [
      ...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    const shellJs = scripts.find((s) => s.includes("function openPane"));
    expect(shellJs, "SPA client JS bundle not found").toBeTruthy();
    expect(shellJs).toContain("mountPaneHost");
    expect(shellJs).toContain("popstate");
    expect(() => new Function(shellJs as string)).not.toThrow();
  });
});
