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
  it.each(["/home", "/my-agents", "/settings"])(
    "%s shows the sign-in prompt to logged-out callers",
    async (path) => {
      const res = await app.fetch(new Request(`http://t${path}`));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sign in to see this page");
    },
  );
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

describe("Owner-shell SPA at /home", () => {
  it("renders the prototype-style shell with sidebar nav + all four views", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="app"');
    expect(html).toContain('<aside class="nav">');
    expect(html).toContain('class="brand"');
    expect(html).toContain('class="logo"');
    expect(html).toContain('data-view="home"');
    expect(html).toContain('data-view="panes"');
    expect(html).toContain('data-view="store"');
    expect(html).toContain('data-view="mine"');
    expect(html).not.toContain('data-view="trash"');
    expect(html).not.toContain('data-view="chrome"');
    // Footer utility links must stay reachable from the shell. /my-agents is
    // where the claim-code generator lives — it has no data-view (full-page
    // nav), so it regressed out of the SPA once already. They live in the
    // account menu (inline on desktop, a popover behind the "Account" tab on
    // mobile); assert both the links and the menu scaffolding are present.
    expect(html).toContain('href="/my-agents"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('id="acct-tab"');
    expect(html).toContain('id="acct-links"');
    // Agent-init instructions modal is always rendered (hidden); tapping an
    // agent-init tile populates + reveals it instead of cold-launching.
    expect(html).toContain('id="ai-modal"');
    expect(html).toContain('class="greet"');
    expect(html).toContain("Alice");
  });

  it("Home view server-renders favorites + recents + all-templates with empty states", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain(">Favorites<");
    expect(html).toContain(">Open panes<");
    expect(html).toContain(">All templates<");
    expect(html).toContain("No favorites yet");
    expect(html).toContain("No open panes");
    expect(html).toContain("Your library is empty");
  });

  it("Template Store view renders the Discover grid", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain(">Discover<");
    expect(html).toContain('id="apps-discover"');
  });

  it("My Templates view renders Yours + Installed grids", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain(">Yours<");
    expect(html).toContain(">Installed from store<");
    expect(html).toContain('id="apps-mine"');
    expect(html).toContain('id="apps-installed"');
  });

  it("surfaces a claimed-agent's template in the Apps `Yours` grid", async () => {
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
      data: { ownerId: agent.id, name: "Reviewer", latestVersion: 1 },
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
    expect(html).toContain("Reviewer");
    expect(html).toContain(`data-template-id="${tpl.id}"`);
  });

  it("surfaces an owned pane in the Panes view as a pane-row", async () => {
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
      data: { ownerId: agent.id, name: "RT", latestVersion: 1 },
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
    expect(html).toContain('class="pane-row"');
    expect(html).toContain("Yesterday's pane");
    expect(html).toContain(">open<");
  });
});

describe("Legacy multi-route 301s to the SPA", () => {
  it.each([
    ["/my-panes", "/home#panes"],
    ["/my-templates", "/home#mine"],
    ["/template-store", "/home#store"],
    ["/trash", "/home"],
    ["/apps", "/home#mine"],
    ["/public-templates", "/home#store"],
  ])("%s → 301 → %s", async (from, to) => {
    const res = await app.fetch(new Request(`http://t${from}`));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(to);
  });
});

describe("brand mark consistency", () => {
  it("/favicon.svg uses the gradient-P shape", async () => {
    const fav = await app.fetch(new Request("http://t/favicon.svg"));
    expect(fav.status).toBe(200);
    expect(fav.headers.get("content-type")).toContain("image/svg+xml");
    const favBody = await fav.text();
    expect(favBody).toContain("pane-brand-grad");
    expect(favBody).toContain("linearGradient");
    expect(favBody).toContain(">P</text>");
  });

  it("/home's SPA shell renders the brand block with the P logo + wordmark", async () => {
    const { cookie } = await seedLoggedInHuman();
    const home = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await home.text();
    // The SPA renders the brand via the prototype's CSS-styled .logo
    // div (background: brand-grad, letter "P"). The shell pulls the
    // same gradient palette from owner-shell-css so the visual matches
    // /favicon.svg.
    expect(html).toContain('<div class="logo">P</div>');
    expect(html).toContain('class="brand"');
    // The CSS bundled with the SPA defines the brand gradient palette.
    expect(html).toContain("--brand-grad:");
  });

  it("/login (the small page outside the SPA) still ships the manifest + favicon link", async () => {
    const res = await app.fetch(new Request("http://t/login"));
    const html = await res.text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
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

// The legacy system-pages chrome (rendered on standalone pages like /settings
// and /my-agents) must use the SAME nav labels and icons as the owner-shell
// SPA — they share NAV_LABELS / NAV_GLYPHS in nav-meta.ts. These assertions
// lock that in so the two navs can't drift back apart.
describe("owner nav consistency (system-pages chrome)", () => {
  it("renders the canonical sentence-case labels, no retired tabs", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/settings", withCookie(cookie)),
    );
    const html = await res.text();
    // Canonical labels (match the SPA sidebar exactly).
    for (const label of [
      "Home",
      "Panes",
      "Template store",
      "My templates",
      "My agents",
      "Settings",
    ]) {
      expect(html).toContain(`>${label}</span>`);
    }
    // Retired / old-style labels must be gone.
    expect(html).not.toContain("My panes");
    expect(html).not.toContain("My Templates"); // title-case variant retired
    expect(html).not.toContain(">Trash<");
    expect(html).not.toContain("/trash");
  });

  it("uses the shared canonical icons (storefront for store, grid for templates)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/settings", withCookie(cookie)),
    );
    const html = await res.text();
    // Storefront awning path = Template store (NOT the 2x2 grid it used to
    // share with My templates).
    expect(html).toContain(`d="M3 3h18l-1.5 5H4.5L3 3z"`);
    // The old document-style My templates icon must be gone.
    expect(html).not.toContain(`d="M4 5h13l3 3v11`);
    // The old person-style My agents icon must be gone (now a robot).
    expect(html).not.toContain(`d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"`);
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
