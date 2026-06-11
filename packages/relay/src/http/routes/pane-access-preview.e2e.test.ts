// End-to-end tests for GET /p/:paneId/preview — the PUBLIC artifact-preview
// endpoint that powers the live thumbnails in the Explore gallery cards.
//
// It is the public counterpart of the owner-gated /panes/:id/preview
// (previews.e2e.test.ts): access reuses resolveAccess, so a `public` pane
// previews for ANYONE (even anonymous), `link` panes preview read-only, and
// invite_only / missing panes stay oracle-free (login/404). Unlike /content
// there is NO status/TTL gate — an ended-but-public pane still renders its last
// artifact as an inert thumbnail.
//
// DB engine follows DATABASE_URL (sqlite by default).

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

async function seedHumanWithCookie(
  email: string,
): Promise<{ humanId: string; cookie: string }> {
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

async function seedPane(opts: {
  ownerHumanId: string;
  accessMode?: string;
  status?: string;
  expiresAt?: Date;
  inputData?: unknown;
  source?: string;
  templateType?: string;
}): Promise<string> {
  const agentKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      keyHash: hashKey(agentKey),
      keyPrefix: keyPrefix(agentKey),
      name: "a-" + randomBytes(3).toString("hex"),
      ownerHumanId: opts.ownerHumanId,
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
      templateType: opts.templateType ?? "html-inline",
      templateSource: opts.source ?? "<p>hi</p>",
      eventSchema: { events: {} },
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: generatePaneId(),
      agentId: agent.id,
      ownerHumanId: opts.ownerHumanId,
      templateVersionId: tv.id,
      title: "Shared Pane",
      status: opts.status ?? "open",
      accessMode: opts.accessMode ?? "invite_only",
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      inputData:
        opts.inputData === undefined ? undefined : (opts.inputData as object),
    },
  });
  return pane.id;
}

// No cookie, no Accept header — the way a sandboxed preview <iframe> fetches.
function anon(): RequestInit {
  return {};
}
function withCookie(cookie: string): RequestInit {
  return { headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` } };
}

describe("GET /p/:paneId/preview", () => {
  it("public pane → 200 artifact body + embedded inputData, anonymously", async () => {
    const owner = await seedHumanWithCookie("pp1@example.com");
    const paneId = await seedPane({
      ownerHumanId: owner.humanId,
      accessMode: "public",
      source: "<h1>Public Preview Marker</h1>",
      inputData: { headline: "Hello world" },
    });

    const res = await app.fetch(
      new Request(`http://t/p/${paneId}/preview`, anon()),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");

    const html = await res.text();
    expect(html).toContain("<h1>Public Preview Marker</h1>");
    expect(html).toContain('"headline":"Hello world"');
    expect(html).toContain("window.pane");
    // Inert preview — no live runtime / WebSocket.
    expect(html).not.toContain("WebSocket");
  });

  it("ENDED public pane still renders (no status/TTL gate, unlike /content)", async () => {
    const owner = await seedHumanWithCookie("pp2@example.com");
    const closedId = await seedPane({
      ownerHumanId: owner.humanId,
      accessMode: "public",
      status: "closed",
      source: "<h1>Closed But Visible</h1>",
    });
    const expiredId = await seedPane({
      ownerHumanId: owner.humanId,
      accessMode: "public",
      expiresAt: new Date(Date.now() - 1000),
      source: "<h1>Expired But Visible</h1>",
    });

    // /content gates these to 410; /preview does not.
    const content = await app.fetch(
      new Request(`http://t/p/${closedId}/content`, anon()),
    );
    expect(content.status).toBe(410);

    const closed = await app.fetch(
      new Request(`http://t/p/${closedId}/preview`, anon()),
    );
    expect(closed.status).toBe(200);
    expect(await closed.text()).toContain("<h1>Closed But Visible</h1>");

    const expired = await app.fetch(
      new Request(`http://t/p/${expiredId}/preview`, anon()),
    );
    expect(expired.status).toBe(200);
    expect(await expired.text()).toContain("<h1>Expired But Visible</h1>");
  });

  it("link pane → 200 (read-only preview allowed)", async () => {
    const owner = await seedHumanWithCookie("pp3@example.com");
    const paneId = await seedPane({
      ownerHumanId: owner.humanId,
      accessMode: "link",
      source: "<h1>Link Preview</h1>",
    });
    const res = await app.fetch(
      new Request(`http://t/p/${paneId}/preview`, anon()),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Link Preview</h1>");
  });

  it("invite_only pane → 404 for anonymous (no oracle) and for logged-in non-grantee", async () => {
    const owner = await seedHumanWithCookie("pp4@example.com");
    const stranger = await seedHumanWithCookie("pp4b@example.com");
    const paneId = await seedPane({
      ownerHumanId: owner.humanId,
      accessMode: "invite_only",
    });

    // Anonymous, no Accept:text/html → the no-oracle API path is a flat 404.
    const anonRes = await app.fetch(
      new Request(`http://t/p/${paneId}/preview`, anon()),
    );
    expect(anonRes.status).toBe(404);

    // Logged-in non-grantee → 404 (never 403).
    const strangerRes = await app.fetch(
      new Request(`http://t/p/${paneId}/preview`, withCookie(stranger.cookie)),
    );
    expect(strangerRes.status).toBe(404);
  });

  it("owner can preview their own invite_only pane", async () => {
    const owner = await seedHumanWithCookie("pp5@example.com");
    const paneId = await seedPane({
      ownerHumanId: owner.humanId,
      accessMode: "invite_only",
      source: "<h1>Owner Sees This</h1>",
    });
    const res = await app.fetch(
      new Request(`http://t/p/${paneId}/preview`, withCookie(owner.cookie)),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Owner Sees This</h1>");
  });

  it("unknown id → 404", async () => {
    const res = await app.fetch(
      new Request("http://t/p/pane_does_not_exist/preview", anon()),
    );
    expect(res.status).toBe(404);
  });

  it("non-html-inline template renders a placeholder, not an error", async () => {
    const owner = await seedHumanWithCookie("pp6@example.com");
    const paneId = await seedPane({
      ownerHumanId: owner.humanId,
      accessMode: "public",
      templateType: "html-ref",
      source: "https://example.com/x",
    });
    const res = await app.fetch(
      new Request(`http://t/p/${paneId}/preview`, anon()),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("html-ref is not implemented");
  });
});

describe("owner-shell SPA — Explore gallery cards", () => {
  it("renders an explore-card with a live preview iframe + scrim for each public pane", async () => {
    // A viewer (no agent of their own) browsing someone ELSE's public pane.
    const viewer = await seedHumanWithCookie("ex-viewer@example.com");
    const sharer = await seedHumanWithCookie("ex-sharer@example.com");
    const paneId = await seedPane({
      ownerHumanId: sharer.humanId,
      accessMode: "public",
    });

    const res = await app.fetch(
      new Request("http://t/home", withCookie(viewer.cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    // The Explore tab is a card grid, not the dense pane-row list.
    expect(html).toContain('class="explore-grid" id="explore-list"');
    expect(html).toContain('class="explore-card"');
    // Each card layers a live preview iframe over the monogram, pointing at the
    // new PUBLIC preview route (works for non-owners). The URL is in data-src;
    // the preview IntersectionObserver promotes it to a real src near-viewport.
    expect(html).toContain(`data-src="/p/${paneId}/preview"`);
    expect(html).toContain('class="tile-preview"');
    expect(html).toContain('class="tile-monogram"');
    // Overlay caption + live pill (the pane is open & unexpired).
    expect(html).toContain('class="ec-scrim"');
    expect(html).toContain('class="ec-pill live"');
    // The card navigates to the public viewer.
    expect(html).toContain(`href="/p/${paneId}"`);
  });

  it("shows the ended pill for a closed public pane", async () => {
    const viewer = await seedHumanWithCookie("ex-viewer2@example.com");
    const sharer = await seedHumanWithCookie("ex-sharer2@example.com");
    await seedPane({
      ownerHumanId: sharer.humanId,
      accessMode: "public",
      status: "closed",
    });

    const res = await app.fetch(
      new Request("http://t/home", withCookie(viewer.cookie)),
    );
    const html = await res.text();
    expect(html).toContain('class="ec-pill ended"');
  });
});
