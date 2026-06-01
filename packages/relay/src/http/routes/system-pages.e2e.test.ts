// End-to-end tests for the Phase D system pages — /login, /home,
// /my-surfaces, /my-templates, /my-agents, /settings.
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
    // The email-magic-link form remains the actual sign-in surface.
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
    "/my-surfaces",
    "/my-templates",
    "/my-agents",
    "/apps",
    "/settings",
  ])("%s shows the sign-in prompt to logged-out callers", async (path) => {
    const res = await app.fetch(new Request(`http://t${path}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to see this page");
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
    expect(html).toContain("My surfaces");
    expect(html).toContain("My agents");
    expect(html).toContain("My templates");
    expect(html).toContain("Settings");
  });
});

describe("GET /my-surfaces (signed in)", () => {
  it("renders the empty state when the human owns no surfaces", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/my-surfaces", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // First-touch empty state — headline, explanation, and two CTAs
    // (Claim an agent / Browse apps) point a new human at the next step.
    expect(html).toContain('class="empty-state"');
    expect(html).toContain("No surfaces yet");
    expect(html).toContain("Claim an agent");
    expect(html).toContain("Browse apps");
  });

  it("lists surfaces the human owns", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    // Seed: an agent + template + version + surface owned by Alice
    const agent = await prisma.agent.create({
      data: { name: "a", keyHash: "x".repeat(64), keyPrefix: "x" },
    });
    const tmpl = await prisma.template.create({
      data: { ownerId: agent.id, name: "t" },
    });
    const tv = await prisma.templateVersion.create({
      data: {
        templateId: tmpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p/>",
      },
    });
    await prisma.surface.create({
      data: {
        id: "sur_test_one",
        agentId: agent.id,
        ownerHumanId: humanId,
        templateVersionId: tv.id,
        title: "Alice's PR review",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const res = await app.fetch(
      new Request("http://t/my-surfaces", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Alice's PR review");
    expect(html).toContain("sur_test_one");
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
    // Cross-links to /apps so a new human can browse before authoring.
    expect(html).toContain('href="/apps"');
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

describe("GET /apps (signed in)", () => {
  it("renders the Apps catalog shell + search input", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/apps", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Apps");
    expect(html).toContain('id="apps-search"');
    expect(html).toContain('id="apps-results"');
    expect(html).toContain("/v1/templates/public");
  });

  it("ships two distinct empty-state copies in the client (catalog empty vs. search miss)", async () => {
    // The /apps results list is rendered client-side, so the e2e check is
    // that the inline JS carries both copies — a regression that collapses
    // them back into the original single string is caught here.
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/apps", withCookie(cookie)),
    );
    const html = await res.text();
    expect(html).toContain("The public catalog is empty");
    expect(html).toContain("pane template publish");
    expect(html).toContain("No apps match");
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
        keyPrefix: "z",
        ownerHumanId: humanId,
        claimedAt: new Date(),
      },
    });
    const res = await app.fetch(
      new Request("http://t/my-agents", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("CodeReviewer");
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
