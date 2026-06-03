// End-to-end tests for the Phase D system pages — /login, /home,
// /my-panes, /my-templates, /my-agents, /settings.
//
// These pages serve raw HTML, so the assertions check status codes,
// content-type, and presence of key DOM landmarks (account email,
// data summaries) rather than fully parsing the markup.

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
import { makeNoneProvider } from "../../auth/providers/none.js";

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;
let appNoEmail: Hono;

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
  appNoEmail = buildApp(
    loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
    }),
    prisma,
    undefined,
    undefined,
    undefined,
    makeNoneProvider(),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

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

function withCookie(cookie: string): RequestInit {
  return { headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` } };
}

describe("GET / (public landing)", () => {
  it("serves the relay's own landing page to logged-out callers", async () => {
    // Previously this 302'd to https://paneui.com; the relay now owns its
    // front door.
    const res = await app.fetch(
      new Request("http://t/", { redirect: "manual" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Pane relay");
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/skills/pane/SKILL.md"');
  });

  it("redirects logged-in humans to /home", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/", {
        ...withCookie(cookie),
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/home");
  });

  it("explains the EMAIL_PROVIDER=none case on the landing", async () => {
    const res = await appNoEmail.fetch(
      new Request("http://t/", { redirect: "manual" }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The body card explains the disabled provider in plain language.
    expect(html).toContain("Human login is disabled");
    // It omits the primary Sign-in button (no card-level CTA). The nav still
    // has a Sign-in link — clicking it lands on /login which renders the
    // same "disabled" message, so the affordance is harmless. We just check
    // the card itself doesn't offer one.
    expect(html).not.toContain('class="btn" href="/login"');
  });
});

describe("GET /login", () => {
  it("returns an HTML page when EMAIL_PROVIDER is configured", async () => {
    const res = await app.fetch(new Request("http://t/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // Hero block tells the story before the form.
    expect(html).toContain("A real UI for the human in the loop");
    expect(html).toContain('id="login-form"');
    // The email-magic-link form remains the actual sign-in pane.
    expect(html).toContain('class="login-hero"');
    expect(html).toContain('class="login-form-card');
  });

  it("renders the mock artifact preview so new visitors see what Pane looks like", async () => {
    const res = await app.fetch(new Request("http://t/login"));
    const html = await res.text();
    expect(html).toContain('class="hero-mock"');
    // Concrete example copy — if this regresses to a generic placeholder
    // the page goes back to telling no story.
    expect(html).toContain("Approve deploy");
    expect(html).toContain("Your CI bot wants you to approve");
  });

  it("explains the EMAIL_PROVIDER=none case", async () => {
    const res = await appNoEmail.fetch(new Request("http://t/login"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Human-side login is disabled");
  });

  it("redirects an already-signed-in human to /home", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/login", {
        ...withCookie(cookie),
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/home");
  });
});

describe("logged-out access to gated pages", () => {
  it.each([
    "/home",
    "/my-panes",
    "/my-templates",
    "/my-agents",
    "/template-store",
    "/settings",
  ])("%s shows the sign-in prompt to logged-out callers", async (path) => {
    const res = await app.fetch(new Request(`http://t${path}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to see this page");
  });
});

describe("legacy /apps + /public-templates redirect to /template-store", () => {
  it("returns 301 from /apps", async () => {
    const res = await app.fetch(new Request("http://t/apps"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/template-store");
  });

  it("returns 301 from /public-templates", async () => {
    const res = await app.fetch(new Request("http://t/public-templates"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/template-store");
  });
});

describe("PWA assets", () => {
  it("serves a valid /manifest.webmanifest", async () => {
    const res = await app.fetch(new Request("http://t/manifest.webmanifest"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    const body = (await res.json()) as {
      name: string;
      start_url: string;
      display: string;
      icons: Array<{ src: string; type: string }>;
    };
    expect(body.name).toBe("pane");
    expect(body.start_url).toBe("/home");
    expect(body.display).toBe("standalone");
    expect(body.icons[0]!.src).toBe("/favicon.svg");
    expect(body.icons[0]!.type).toBe("image/svg+xml");
  });

  it("serves /favicon.svg as image/svg+xml", async () => {
    const res = await app.fetch(new Request("http://t/favicon.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body.startsWith("<svg")).toBe(true);
  });

  it("every layout-served page links the manifest", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
  });
});

describe("mobile bottom-tab navigation", () => {
  it("renders the bottom-tabs nav alongside the header strip", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    // Both nav variants present on every page — CSS shows/hides via viewport.
    expect(html).toContain('class="bottom-tabs"');
    expect(html).toContain('aria-label="Primary (mobile)"');
    // Bottom-bar uses shorter labels ("Store", "Panes", "Templates") so the
    // tap targets fit on iPhone-SE width.
    expect(html).toContain(">Store<");
    expect(html).toContain(">Panes<");
    expect(html).toContain(">Templates<");
  });

  it("each tab item carries its inline SVG icon", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain('class="tab-ico"');
  });
});

describe("GET /home (signed in)", () => {
  it("renders the home page with the human's email", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alice@example.com");
    expect(html).toContain("My panes");
    expect(html).toContain("My agents");
    expect(html).toContain("My templates");
    expect(html).toContain("Settings");
  });

  it("renders gradient greeting + stats + wired search bar", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Greeting line with gradient name span.
    expect(html).toContain('class="home-greet"');
    expect(html).toContain('class="home-greet-name"');
    // Local-part heuristic: alice@example.com → "Alice" (no human.name set).
    expect(html).toContain(">Alice<");
    // Stats subline appears with humanised counts.
    expect(html).toContain('class="home-stats"');
    expect(html).toContain("templates in your library");
    // Search bar present + the client-side filter is wired (function
    // definition is inlined in the page's script).
    expect(html).toContain('id="home-search"');
    expect(html).toContain("Search templates, panes, anything");
    expect(html).toContain("matchableText");
  });

  it("prefers human.name over the email-local heuristic in the greeting", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    await prisma.human.update({
      where: { id: humanId },
      data: { name: "Lalit" },
    });
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    // The gradient name span carries the persisted name, not the
    // email-local "Alice" heuristic.
    expect(html).toContain(">Lalit<");
    expect(html).not.toMatch(/home-greet-name">Alice</);
  });

  it("login form carries the optional Name input", async () => {
    const res = await app.fetch(new Request("http://t/login"));
    const html = await res.text();
    expect(html).toContain('id="name"');
    expect(html).toContain("Your name");
    expect(html).toContain('autocomplete="name"');
  });

  it("renders Favourites + Open panes + All templates sections", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    // Three section heads (uppercase-styled in the prototype but rendered
    // verbatim in markup).
    expect(html).toContain(">Favourites<");
    expect(html).toContain(">Open panes<");
    expect(html).toContain(">All templates<");
    // Empty-state copies for a brand-new account (no installs, no panes,
    // no owned templates).
    expect(html).toContain("No favourites yet");
    expect(html).toContain("No open panes");
    expect(html).toContain("Your template library is empty");
  });

  it("surfaces an installed template as a 76x76 Favourite tile with launch wiring", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "claimed",
        keyHash: "h".repeat(64),
        keyPrefix: "h",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const tpl = await prisma.template.create({
      data: { ownerId: agent.id, name: "My favourite", latestVersion: 1 },
    });
    await prisma.templateVersion.create({
      data: {
        templateId: tpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<html></html>",
      },
    });
    await prisma.humanTemplateInstall.create({
      data: { humanId, templateId: tpl.id, installedVersion: 1 },
    });

    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    // .favs horizontal scroll strip + .fav-tile child with the
    // template id wired to the launch handler.
    expect(html).toContain('class="favs"');
    expect(html).toContain('class="fav-tile"');
    expect(html).toContain(`data-template-id="${tpl.id}"`);
    expect(html).toContain("My favourite");
    expect(html).not.toContain("No favourites yet");
    // 76×76 gradient icon class present.
    expect(html).toContain("fav-tile-icon");
  });

  it("surfaces an owned template in the All-templates Launchpad grid", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "claimed",
        keyHash: "t".repeat(64),
        keyPrefix: "t",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const tpl = await prisma.template.create({
      data: {
        ownerId: agent.id,
        name: "My owned tpl",
        latestVersion: 1,
      },
    });
    await prisma.templateVersion.create({
      data: {
        templateId: tpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<html></html>",
      },
    });

    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain('class="apps-grid"');
    expect(html).toContain('class="app-tile"');
    expect(html).toContain(`data-template-id="${tpl.id}"`);
    expect(html).toContain("My owned tpl");
    expect(html).not.toContain("Your template library is empty");
  });

  it("surfaces an owned pane as a horizontal recent-card with thumb + tag", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "claimed",
        keyHash: "r".repeat(64),
        keyPrefix: "r",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const tpl = await prisma.template.create({
      data: { ownerId: agent.id, name: "Recent Tpl", latestVersion: 1 },
    });
    const version = await prisma.templateVersion.create({
      data: {
        templateId: tpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<html></html>",
      },
    });
    await prisma.pane.create({
      data: {
        id: `pan_${randomBytes(8).toString("hex")}`,
        agentId: agent.id,
        ownerHumanId: humanId,
        templateVersionId: version.id,
        title: "Yesterday's pane",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    // .recents strip + .recent-card child with the version tag.
    expect(html).toContain('class="recents"');
    expect(html).toContain('class="recent-card"');
    expect(html).toContain("Yesterday's pane");
    expect(html).toContain('class="recent-thumb"');
    // Version tag overlay on the thumb.
    expect(html).toContain('class="recent-tag"');
    expect(html).toContain(">v1<");
  });
});

describe("GET /my-panes (signed in)", () => {
  it("renders the empty state when the human owns no panes", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/my-panes", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // First-touch empty state — headline, explanation, and two CTAs
    // (Claim an agent / Browse the template store) point a new human at the next step.
    expect(html).toContain('class="empty-state"');
    expect(html).toContain("No panes yet");
    expect(html).toContain("Claim an agent");
    expect(html).toContain("Browse the template store");
  });

  it("renders a pane card with title, template, agent, and id", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "deploy-bot",
        keyHash: "x".repeat(64),
        keyPrefix: "x",
      },
    });
    const tmpl = await prisma.template.create({
      data: { ownerId: agent.id, name: "PR Review", slug: "pr-review" },
    });
    const tv = await prisma.templateVersion.create({
      data: {
        templateId: tmpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p/>",
      },
    });
    await prisma.pane.create({
      data: {
        id: "pan_test_one",
        agentId: agent.id,
        ownerHumanId: humanId,
        templateVersionId: tv.id,
        title: "Alice's PR review",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const res = await app.fetch(
      new Request("http://t/my-panes", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="pane-card"');
    // The page's escapeHtml only encodes &, <, >, " — apostrophe stays literal,
    // matching the existing behaviour of every other title rendered into the
    // signed-in pages.
    expect(html).toContain("Alice's PR review");
    expect(html).toContain("pan_test_one");
    // The new card panes the template name + the agent that created it
    // so the human can tell two panes of the same template apart.
    expect(html).toContain("PR Review");
    expect(html).toContain("deploy-bot");
    // The avatar tile carries hash-derived hue + the template initials.
    expect(html).toContain("pane-card-tile");
    expect(html).toContain("--tile-h:");
    expect(html).toMatch(/>PR<\/div>/);
  });

  it("falls back to the slug then to 'ad-hoc template' for unnamed templates", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: { name: "a", keyHash: "y".repeat(64), keyPrefix: "y" },
    });
    // Anonymous template (no name, no slug) — created by the inline
    // POST /v1/panes path. The card should still render with a
    // useful label rather than a blank.
    const tmpl = await prisma.template.create({
      data: { ownerId: agent.id },
    });
    const tv = await prisma.templateVersion.create({
      data: {
        templateId: tmpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p/>",
      },
    });
    await prisma.pane.create({
      data: {
        id: "pan_anon",
        agentId: agent.id,
        ownerHumanId: humanId,
        templateVersionId: tv.id,
        title: "Quick form",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const res = await app.fetch(
      new Request("http://t/my-panes", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain("ad-hoc template");
  });

  // #301 — /my-panes should reflect every pane the human has access
  // to, not just ones they own. Pre-fix only ownerHumanId rows surfaced
  // here; a human who joined a colleague's surface had no recovery path.
  it("includes surfaces opened as a (non-revoked) participant, not just owned ones", async () => {
    const { humanId, cookie } = await seedLoggedInHuman("bob@example.com");
    const ownerAgent = await prisma.agent.create({
      data: {
        name: "owner-bot",
        keyHash: "y".repeat(64),
        keyPrefix: "y",
      },
    });
    const tmpl = await prisma.template.create({
      data: { ownerId: ownerAgent.id, name: "Survey", slug: "survey" },
    });
    const tv = await prisma.templateVersion.create({
      data: {
        templateId: tmpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p/>",
      },
    });
    // Surface owned by someone else (no ownerHumanId pointing at our human),
    // but our human is identity-bound on it via a non-revoked participant.
    const surface = await prisma.pane.create({
      data: {
        id: "sur_invited",
        agentId: ownerAgent.id,
        templateVersionId: tv.id,
        title: "Bob's invited survey",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.participant.create({
      data: {
        paneId: surface.id,
        kind: "human",
        identityId: humanId,
        humanId,
        tokenHash: "z".repeat(64),
        tokenPrefix: "tok_h_pre",
      },
    });

    const res = await app.fetch(
      new Request("http://t/my-panes", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Bob's invited survey");
    expect(html).toContain("sur_invited");
  });

  it("excludes surfaces where the human's participant row was revoked", async () => {
    const { humanId, cookie } = await seedLoggedInHuman("carol@example.com");
    const ownerAgent = await prisma.agent.create({
      data: {
        name: "owner-bot-2",
        keyHash: "a".repeat(64),
        keyPrefix: "a",
      },
    });
    const tv = await prisma.templateVersion.create({
      data: {
        template: {
          create: { ownerId: ownerAgent.id, name: "T", slug: "t-revoked" },
        },
        version: 1,
        templateType: "html-inline",
        templateSource: "<p/>",
      },
    });
    const surface = await prisma.pane.create({
      data: {
        id: "sur_kicked",
        agentId: ownerAgent.id,
        templateVersionId: tv.id,
        title: "Pane Carol was kicked from",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.participant.create({
      data: {
        paneId: surface.id,
        kind: "human",
        identityId: humanId,
        humanId,
        tokenHash: "b".repeat(64),
        tokenPrefix: "tok_h_kicked",
        revokedAt: new Date(),
      },
    });

    const res = await app.fetch(
      new Request("http://t/my-panes", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).not.toContain("Pane Carol was kicked from");
    // Empty-state should render — no surfaces.
    expect(html).toContain("No panes yet");
  });

  it("does not double-list a surface where the human is BOTH owner and participant", async () => {
    const { humanId, cookie } = await seedLoggedInHuman("dana@example.com");
    const agent = await prisma.agent.create({
      data: {
        name: "dana-bot",
        keyHash: "d".repeat(64),
        keyPrefix: "d",
      },
    });
    const tv = await prisma.templateVersion.create({
      data: {
        template: {
          create: { ownerId: agent.id, name: "T", slug: "t-self" },
        },
        version: 1,
        templateType: "html-inline",
        templateSource: "<p/>",
      },
    });
    const surface = await prisma.pane.create({
      data: {
        id: "sur_self",
        agentId: agent.id,
        ownerHumanId: humanId,
        templateVersionId: tv.id,
        title: "Self pane",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.participant.create({
      data: {
        paneId: surface.id,
        kind: "human",
        identityId: humanId,
        humanId,
        tokenHash: "e".repeat(64),
        tokenPrefix: "tok_h_self",
      },
    });

    const res = await app.fetch(
      new Request("http://t/my-panes", withCookie(cookie)),
    );
    const html = await res.text();
    // The surface card appears exactly once — count the title or the id.
    const matches = html.match(/sur_self/g) ?? [];
    // The id appears in the card body (once) and potentially in a link href
    // (once) — but never duplicated by the OR query itself. Allow up to a
    // couple of occurrences inside one card; verify the title is exactly
    // once which is the user-visible signal.
    expect(matches.length).toBeGreaterThan(0);
    const titleMatches = html.match(/Self pane/g) ?? [];
    expect(titleMatches).toHaveLength(1);
  });
});

describe("GET /my-templates (signed in)", () => {
  it("renders the empty state when no claimed agents own templates", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/my-templates", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="empty-state"');
    expect(html).toContain("haven't authored any templates");
    expect(html).toContain("pane template create");
    // Cross-links to /template-store so a new human can browse before authoring.
    expect(html).toContain('href="/template-store"');
  });

  it("lists templates owned by the human's claimed agents", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "claimed",
        keyHash: "y".repeat(64),
        keyPrefix: "y",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    await prisma.template.create({
      data: { ownerId: agent.id, name: "Reviewer", slug: "pr-review" },
    });
    const res = await app.fetch(
      new Request("http://t/my-templates", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Reviewer");
    // Publish form is rendered on every authored template (#279 PR B)
    expect(html).toContain("Publish to catalog");
    expect(html).toContain("/v1/my-templates/");
  });

  it("renders the Unpublish form on already-published authored templates", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agent = await prisma.agent.create({
      data: {
        name: "claimed",
        keyHash: "u".repeat(64),
        keyPrefix: "u",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    await prisma.template.create({
      data: {
        ownerId: agent.id,
        name: "Live",
        publishedAt: new Date(),
        installCount: 7,
      },
    });
    const res = await app.fetch(
      new Request("http://t/my-templates", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain("Live");
    expect(html).toContain("Unpublish");
    expect(html).toContain("7 installs");
  });
});

describe("GET /template-store (signed in)", () => {
  it("renders the Template store catalog shell + search input", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/template-store", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Template store");
    expect(html).toContain('id="catalog-search"');
    expect(html).toContain('id="catalog-results"');
    expect(html).toContain("/v1/templates/public");
  });

  it("uses the Launchpad-style grid (matches /home All-templates visual)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/template-store", withCookie(cookie)),
    );
    const html = await res.text();
    // New grid container + per-item card class. The store-card structure
    // mirrors the home page's app-tile but exposes the install action
    // inline (vs. tap-to-launch on /home's tiles).
    expect(html).toContain('class="store-grid"');
    // Hue + initial-rendering helpers inlined client-side so the same
    // tile color matches /home's All-templates tile for the same id.
    expect(html).toContain("function hueFor");
    expect(html).toContain("function initials");
    // Search input is wrapped in the prototype-style search box with
    // its leading SVG icon — same shape as /home's search.
    expect(html).toContain('class="store-search"');
    expect(html).toContain('class="store-search-icon"');
  });

  it("ships two distinct empty-state copies in the client (catalog empty vs. search miss)", async () => {
    // The /template-store results list is rendered client-side, so the
    // e2e check is that the inline JS carries both copies — a regression
    // that collapses them back into the original single string is caught here.
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/template-store", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain("The public catalog is empty");
    expect(html).toContain("pane template publish");
    expect(html).toContain("No templates match");
  });
});

describe("brand mark consistency", () => {
  it("/favicon.svg + the inline header logo share the same gradient body", async () => {
    const fav = await app.fetch(new Request("http://t/favicon.svg"));
    expect(fav.status).toBe(200);
    expect(fav.headers.get("content-type")).toContain("image/svg+xml");
    const favBody = await fav.text();
    // The new logo uses a brand gradient (pane-brand-grad) + the letter
    // "P" instead of the old robot-face shape.
    expect(favBody).toContain("pane-brand-grad");
    expect(favBody).toContain("linearGradient");
    expect(favBody).toContain(">P</text>");

    // The system-page header pulls in the same SVG. Render any system
    // page and confirm the same gradient id + P appear.
    const { cookie } = await seedLoggedInHuman();
    const home = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const homeHtml = await home.text();
    expect(homeHtml).toContain("pane-brand-grad");
    expect(homeHtml).toContain(">P</text>");
  });
});

describe("GET /my-agents (signed in)", () => {
  it("renders the empty state with the claim-new button", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/my-agents", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="empty-state"');
    expect(html).toContain("No claimed agents yet");
    expect(html).toContain("pane agent claim");
    expect(html).toContain("Generate claim code");
  });

  it("lists the human's claimed agents", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    await prisma.agent.create({
      data: {
        name: "CodeReviewer",
        keyHash: "z".repeat(64),
        keyPrefix: "pane_abc123",
        ownerHumanId: humanId,
        claimedAt: new Date(),
        lastUsedAt: new Date(),
      },
    });
    const res = await app.fetch(
      new Request("http://t/my-agents", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("CodeReviewer");
    // The agent row now surfaces the keyPrefix, the relative
    // last-used time, and a Regenerate-key button.
    expect(html).toContain("pane_abc123");
    expect(html).toContain("last used today");
    expect(html).toContain("Regenerate key");
    expect(html).toContain('data-act="rotate"');
  });

  it("hides the Regenerate-key button on revoked agents", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    await prisma.agent.create({
      data: {
        name: "Revoked",
        keyHash: "y".repeat(64),
        keyPrefix: "pane_xyz",
        ownerHumanId: humanId,
        claimedAt: new Date(),
        revokedAt: new Date(),
      },
    });
    const res = await app.fetch(
      new Request("http://t/my-agents", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain("Revoked");
    // No rotate affordance on a revoked agent — rotation doesn't unrevoke.
    expect(html).not.toContain('data-act="rotate"');
  });

  it("shows 'last used never' when an agent hasn't authenticated yet", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    await prisma.agent.create({
      data: {
        name: "FreshAgent",
        keyHash: "w".repeat(64),
        keyPrefix: "pane_fresh",
        ownerHumanId: humanId,
        claimedAt: new Date(),
        lastUsedAt: null,
      },
    });
    const res = await app.fetch(
      new Request("http://t/my-agents", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain("last used never");
  });
});

describe("GET /settings (signed in)", () => {
  it("renders the settings page with email + sign-out", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/settings", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alice@example.com");
    expect(html).toContain("Sign out of this device");
  });
});

describe("auth.verify redirect", () => {
  it("redirects newly-verified humans to /home by default", async () => {
    const { generateMagicLinkToken, hashMagicLinkToken } =
      await import("../../auth/magic-link.js");
    const raw = generateMagicLinkToken();
    await prisma.magicLink.create({
      data: {
        email: "alice@example.com",
        tokenHash: hashMagicLinkToken(raw),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/home");
  });
});
