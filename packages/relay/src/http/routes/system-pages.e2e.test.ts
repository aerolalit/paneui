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
      // Disable the owner-shell open-pane list gate here — these shell tests
      // assert that an owned template renders in the "Yours" grid without
      // seeding open panes. The gate has dedicated coverage in
      // template-open-pane-gates.e2e.test.ts.
      TEMPLATE_LIST_MIN_OPEN_PANES: "0",
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

describe("F-18 — Content-Security-Policy on system pages", () => {
  // F-18 follow-up: these pages now carry a NONCE-based CSP (no
  // 'unsafe-inline' on script-src; system-pages-authored HTML also drops it on
  // style-src) plus the sibling hardening headers the owner-shell / bridge
  // HTML mounts already set. Every inline <script>/<style> carries the
  // per-request nonce, so a CSP that blocks the page's own scripts would be a
  // regression — the tests below assert the nonce actually matches.

  // Extract the script-src nonce token from a CSP header value.
  function scriptNonce(csp: string): string | null {
    const m = csp.match(/script-src 'nonce-([^']+)'/);
    return m ? (m[1] ?? null) : null;
  }
  function styleNonce(csp: string): string | null {
    const m = csp.match(/style-src 'nonce-([^']+)'/);
    return m ? (m[1] ?? null) : null;
  }

  it.each([
    ["/", undefined],
    ["/login", undefined],
  ])(
    "sets a nonce-based CSP (no 'unsafe-inline') on the public HTML page %s",
    async (path) => {
      const res = await app.fetch(new Request(`http://t${path}`));
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      // Nonce-only on both script-src and style-src — NO 'unsafe-inline'.
      expect(csp).toMatch(/script-src 'nonce-[^']+'/);
      expect(csp).toMatch(/style-src 'nonce-[^']+'/);
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      // No remote script origin is ever allowed.
      expect(csp).not.toMatch(/script-src[^;]*https?:/);

      // The page's own inline blocks carry the matching nonce, so the CSP
      // does not block the page's own scripts/styles.
      const html = await res.text();
      const sNonce = scriptNonce(csp);
      const stNonce = styleNonce(csp);
      expect(sNonce).toBeTruthy();
      expect(stNonce).toBe(sNonce);
      // Every inline <script>/<style> element must carry the nonce.
      const inlineTags = [
        ...html.matchAll(/<(script|style)(\s[^>]*)?>/g),
      ].filter((m) => {
        const attrs = m[2] ?? "";
        // Skip non-executable JSON script blocks (type="application/json").
        return !/type="application\/json"/.test(attrs);
      });
      expect(inlineTags.length).toBeGreaterThan(0);
      for (const tag of inlineTags) {
        expect(tag[0]).toContain(`nonce="${sNonce}"`);
      }

      // Sibling hardening headers match the owner-shell / bridge mounts.
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("permissions-policy")).toBeTruthy();
    },
  );

  it("sets a nonce CSP on authenticated pages (/my-agents) and nonces every inline block", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/my-agents", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).toMatch(/style-src 'nonce-[^']+'/);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");

    const html = await res.text();
    // The page still emits its inline behaviour scripts — now nonce'd, not
    // 'unsafe-inline'. The nonce must match or the script won't execute.
    expect(html).toContain('id="gen-code"');
    const sNonce = scriptNonce(csp);
    expect(sNonce).toBeTruthy();
    const inlineTags = [...html.matchAll(/<(script|style)(\s[^>]*)?>/g)].filter(
      (m) => !/type="application\/json"/.test(m[2] ?? ""),
    );
    expect(inlineTags.length).toBeGreaterThan(0);
    for (const tag of inlineTags) {
      expect(tag[0]).toContain(`nonce="${sNonce}"`);
    }
    // No inline style="…" attribute survives — those are blocked under the
    // nonce-only style-src and were migrated to classes.
    expect(html).not.toMatch(/\sstyle="/);
  });

  it("nonces the /home SPA script (dropping script-src 'unsafe-inline')", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    // Scripts are nonce-only on /home too — no 'unsafe-inline' in script-src.
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    // style-src KEEPS 'unsafe-inline' here — documented interim for the SPA's
    // dynamic per-element hue-gradient inline style attributes (server- AND
    // client-rendered) that a nonce cannot cover.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");

    const html = await res.text();
    const sNonce = scriptNonce(csp);
    expect(sNonce).toBeTruthy();
    // The SPA's inline <script> + <style> both carry the matching nonce.
    const inlineTags = [...html.matchAll(/<(script|style)(\s[^>]*)?>/g)].filter(
      (m) => !/type="application\/json"/.test(m[2] ?? ""),
    );
    expect(inlineTags.length).toBeGreaterThan(0);
    for (const tag of inlineTags) {
      expect(tag[0]).toContain(`nonce="${sNonce}"`);
    }
  });

  it("does NOT apply the HTML CSP to non-HTML asset routes", async () => {
    // /manifest.webmanifest and /favicon.svg are not text/html, so the
    // middleware leaves them alone (no CSP injected on JSON / SVG assets).
    for (const path of ["/manifest.webmanifest", "/favicon.svg"]) {
      const res = await app.fetch(new Request(`http://t${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBeNull();
    }
  });
});

describe("logged-out access to gated pages", () => {
  it.each(["/home", "/my-agents"])(
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
      icons: Array<{
        src: string;
        type: string;
        sizes: string;
        purpose: string;
      }>;
    };
    expect(body.name).toBe("pane");
    expect(body.start_url).toBe("/home");
    expect(body.display).toBe("standalone");
    // PNG raster icons drive the Android/desktop install (iOS uses the
    // apple-touch-icon link). The 180 must lead; a maskable PNG must exist.
    expect(body.icons[0]!.src).toBe("/apple-touch-icon.png");
    expect(body.icons[0]!.type).toBe("image/png");
    expect(
      body.icons.some(
        (i) => i.type === "image/png" && i.purpose.includes("maskable"),
      ),
    ).toBe(true);
    // The scalable SVG is kept as a progressive-enhancement fallback.
    expect(
      body.icons.some(
        (i) => i.src === "/favicon.svg" && i.type === "image/svg+xml",
      ),
    ).toBe(true);
  });

  it("serves /favicon.svg as image/svg+xml", async () => {
    const res = await app.fetch(new Request("http://t/favicon.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body.startsWith("<svg")).toBe(true);
  });

  it.each([
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/icon-192.png",
    "/icon-512.png",
  ])("serves %s as a PNG image", async (path) => {
    const res = await app.fetch(new Request("http://t" + path));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic number: 89 50 4E 47 — confirms real raster bytes, not an
    // empty/HTML body.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
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
    // Without this link, iOS "Add to Home Screen" falls back to a screenshot.
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('href="/apple-touch-icon.png"');
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
    // Settings is now an in-app SPA view (#settings), not a full-page nav.
    expect(html).toContain('href="#settings"');
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
    await prisma.pane.create({
      data: {
        id: `pan_${randomBytes(8).toString("hex")}`,
        agentId: agent.id,
        ownerHumanId: humanId,
        templateVersionId: version.id,
        title: "Closed pane",
        status: "closed",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain('class="pane-row"');
    // Each pane row carries a Share affordance that opens the Share dialog.
    expect(html).toContain("data-pane-share=");
    // F-15: the SPA escaper encodes single quotes (' -> &#39;), so a title
    // with an apostrophe renders in its encoded form — the raw apostrophe
    // must NOT appear inside the title text.
    expect(html).toContain("Yesterday&#39;s pane");
    expect(html).not.toContain("Yesterday's pane");
    // Open is the default state, so open rows render no status pill (just an
    // empty cell) — only the exceptional "closed" state is flagged.
    expect(html).not.toContain(">open<");
    expect(html).toContain(">closed<");
  });

  it("renders the Share dialog scaffolding + Recently-viewed section", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    // Share dialog is always present (hidden); opened client-side per-pane.
    expect(html).toContain('id="share-modal"');
    expect(html).toContain('id="share-title"');
    expect(html).toContain('id="share-invite-form"');
    expect(html).toContain('id="share-visibility"');
    expect(html).toContain('id="share-copy-link"');
    // Recently-viewed section is rendered (hidden) and hydrated from
    // /v1/self/recents on load.
    expect(html).toContain('id="recently-viewed-section"');
    expect(html).toContain(">Recently viewed<");
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
  it("/favicon.svg renders the robot brand mark (same as the install icons)", async () => {
    const fav = await app.fetch(new Request("http://t/favicon.svg"));
    expect(fav.status).toBe(200);
    expect(fav.headers.get("content-type")).toContain("image/svg+xml");
    const favBody = await fav.text();
    // Robot mark fills: navy tile, cyan circle, purple chat-bubble. The old
    // gradient-"P" (linearGradient + <text>P</text>) must be gone — the favicon
    // now matches the home-screen / install icons.
    expect(favBody).toContain('fill="#22d3ee"'); // cyan circle
    expect(favBody).toContain('fill="#a78bfa"'); // purple bubble
    expect(favBody).not.toContain("linearGradient");
    expect(favBody).not.toContain(">P</text>");
  });

  it("/home's SPA shell renders the brand block with the robot logo + wordmark", async () => {
    const { cookie } = await seedLoggedInHuman();
    const home = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await home.text();
    // The SPA brand block renders the robot mark (inline SVG) inside the .logo
    // tile — the same artwork as /favicon.svg and the install icons.
    expect(html).toContain('class="brand"');
    expect(html).toContain('<div class="logo"><svg');
    expect(html).toContain('fill="#a78bfa"'); // purple bubble = the robot mark
    expect(html).not.toContain('<div class="logo">P</div>');
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
  it("redirects into the SPA settings view (#settings)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/settings", withCookie(cookie)),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/home#settings");
  });

  it("renders the settings content (email + sign-out) inside /home", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain('data-view="settings"');
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
    // /my-agents is still a standalone system page (renders the legacy chrome);
    // /settings now redirects into the SPA, so assert the chrome on /my-agents.
    const res = await app.fetch(
      new Request("http://t/my-agents", withCookie(cookie)),
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
      new Request("http://t/my-agents", withCookie(cookie)),
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
