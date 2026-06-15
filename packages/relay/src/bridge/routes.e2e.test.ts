// End-to-end test for the bridge routes — exercises the /presence endpoint
// (polled by the shell to keep the agent-presence pill fresh) through the
// real Hono app. DB engine follows DATABASE_URL (sqlite or postgres).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { seedPaneRow } from "../test-helpers/seed.js";
import { createPrismaClient } from "../db.js";
import { loadConfig } from "../config.js";
import { hashKey, keyPrefix, generateHumanParticipantToken } from "../keys.js";
import { buildApp } from "../http/app.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(loadConfig(), prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

const minimalSchema = {
  events: {
    "review.commentAdded": {
      payload: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      emittedBy: ["page", "agent"],
    },
  },
};

// Seed an agent + pane + one human participant, returning the
// participant token (the bridge URL credential) and the agent id.
async function seedPane(opts?: {
  agentLastUsedAt?: Date;
  closed?: boolean;
  expired?: boolean;
  templateSource?: string;
  inputData?: object | null;
  title?: string;
  preamble?: string | null;
}): Promise<{
  token: string;
  agentId: string;
  paneId: string;
}> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      lastUsedAt: opts?.agentLastUsedAt ?? null,
    },
  });
  const { paneId } = await seedPaneRow(prisma, {
    agentId: agent.id,
    templateSource: opts?.templateSource ?? "<html></html>",
    eventSchema: minimalSchema,
    inputData: opts?.inputData ?? null,
    status: opts?.closed ? "closed" : "open",
    expiresAt: opts?.expired
      ? new Date(Date.now() - 60 * 60 * 1000)
      : new Date(Date.now() + 60 * 60 * 1000),
    ...(opts?.title !== undefined ? { title: opts.title } : {}),
    ...(opts?.preamble !== undefined ? { preamble: opts.preamble } : {}),
  });
  const token = generateHumanParticipantToken();
  await prisma.participant.create({
    data: {
      paneId,
      kind: "human",
      identityId: "human-1",
      tokenHash: hashKey(token),
      tokenPrefix: keyPrefix(token),
    },
  });
  return { token, agentId: agent.id, paneId };
}

describe("bridge /presence", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the three presence fields as JSON", async () => {
    const usedAt = new Date(Date.now() - 5000);
    const { token } = await seedPane({ agentLastUsedAt: usedAt });

    const res = await app.fetch(new Request(`http://t/s/${token}/presence`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      agentLive: boolean;
      agentLastEventAt: string | null;
      agentLastUsedAt: string | null;
    };
    expect(body.agentLive).toBe(false);
    expect(body.agentLastEventAt).toBeNull();
    expect(body.agentLastUsedAt).toBe(usedAt.toISOString());
  });

  it("reports agentLastEventAt from the most recent agent-authored event", async () => {
    const { token, paneId } = await seedPane();
    await prisma.event.create({
      data: {
        paneId,
        authorKind: "agent",
        authorId: "agent-x",
        type: "review.commentAdded",
        data: { body: "hi" },
      },
    });

    const res = await app.fetch(new Request(`http://t/s/${token}/presence`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentLastEventAt: string | null };
    expect(body.agentLastEventAt).not.toBeNull();
  });

  it("404s on a bad token", async () => {
    const res = await app.fetch(
      new Request("http://t/s/not-a-real-token/presence"),
    );
    expect(res.status).toBe(404);
  });

  it("404s on a well-formed but unknown token", async () => {
    // Valid `tok_h_`-shaped token that passes TOKEN_RX but is not seeded —
    // exercises the DB-miss path rather than the regex-reject path.
    const bogus = generateHumanParticipantToken();
    const res = await app.fetch(new Request(`http://t/s/${bogus}/presence`));
    expect(res.status).toBe(404);
  });
});

describe("bridge shell GET /s/:token", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns 200 text/html for a valid open pane", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("sets the framing/caching security headers", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("sets a nonce-based CSP that confines scripts and connections", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it("sets a permissions-policy that disables sensitive APIs", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const pp = res.headers.get("permissions-policy") ?? "";
    expect(pp).toContain("camera=()");
    expect(pp).toContain("geolocation=()");
  });

  it("inlines the pane-cfg JSON block carrying the participant token", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).toContain('<script type="application/json" id="pane-cfg">');
    expect(body).toContain(token);
  });

  // Phase C — the shell config carries the pane's input_data so the
  // runtime can expose it to the template as `window.pane.inputData`.
  it("inlines the pane's input_data into the pane-cfg block", async () => {
    const { token } = await seedPane({
      inputData: { prTitle: "Fix the bug", files: ["a.ts"] },
    });
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    const m = body.match(
      /<script type="application\/json" id="pane-cfg">(.*?)<\/script>/s,
    );
    expect(m).toBeTruthy();
    const cfg = JSON.parse(m![1]!.replace(/\\u003c/g, "<")) as {
      inputData: unknown;
    };
    expect(cfg.inputData).toEqual({ prTitle: "Fix the bug", files: ["a.ts"] });
  });

  it("sets pane-cfg inputData to null when the pane has no input_data", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    const m = body.match(
      /<script type="application\/json" id="pane-cfg">(.*?)<\/script>/s,
    );
    const cfg = JSON.parse(m![1]!.replace(/\\u003c/g, "<")) as {
      inputData: unknown;
    };
    expect(cfg.inputData).toBeNull();
  });

  it("renders an iframe pointing at the content route", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).toContain("<iframe");
    expect(body).toContain(`src="/s/${token}/content"`);
  });

  it("does NOT embed the system-pages top nav on capability-token shells", async () => {
    // /s/<token> is the share-link path — the caller is either anonymous
    // or a non-owner participant, neither of which has access to /home or
    // /my-panes. Showing those tabs would just produce dead links. The
    // owner-shell mount (/panes/:id, separate route) is where the nav
    // belongs; here it must stay absent.
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    // The CSS rules for .top-nav-* sit in the stylesheet either way (cheap
    // to keep them there than to template the <style> block). What MUST NOT
    // appear is the rendered nav itself or the sign-out handler.
    expect(body).not.toContain('class="top-nav-bar"');
    expect(body).not.toContain('id="top-nav-signout"');
    expect(body).not.toContain('href="/home"');
    expect(body).not.toContain('href="/my-panes"');
  });

  it("renders the agent-supplied preamble in a context band above the iframe", async () => {
    const { token } = await seedPane({
      preamble: "Your CI bot wants you to approve a deploy to staging.",
    });
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).toContain('class="preamble"');
    expect(body).toContain(
      "Your CI bot wants you to approve a deploy to staging.",
    );
    // Order: the preamble band must appear before the <iframe>, so the
    // human reads the context first.
    const preIdx = body.indexOf('class="preamble"');
    const iframeIdx = body.indexOf("<iframe");
    expect(preIdx).toBeGreaterThan(-1);
    expect(iframeIdx).toBeGreaterThan(preIdx);
  });

  it("omits the preamble band entirely when the agent didn't supply one", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).not.toContain('class="preamble"');
  });

  it("HTML-escapes preamble content (XSS defence in the shell band)", async () => {
    const { token } = await seedPane({
      preamble: '<script>alert("x")</script> & "quotes"',
    });
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    // The escaped text appears; the raw script tag does not.
    expect(body).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;quotes&quot;",
    );
    // Defence-in-depth: no unescaped <script>alert(... in the page body
    // outside of the legitimate config + shell script blocks.
    expect(body).not.toMatch(/<script[^>]*>alert\(/);
  });

  it("sandboxes the template iframe with allow-scripts and allow-forms", async () => {
    // The template runs in a sandboxed iframe. `allow-scripts` is required so
    // the inline <script> in the template (and the pane runtime) can run.
    // `allow-forms` lets natural `<form>` UIs dispatch their `submit` event to
    // JS — without it, Chrome blocks the submission *before* the handler runs,
    // so `pane.emit(...)` never fires. The iframe has no `allow-same-origin`,
    // so forms still can't reach a real origin even with this flag.
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    const m = body.match(/<iframe[^>]*\ssandbox="([^"]+)"/);
    expect(m).not.toBeNull();
    const tokens = (m![1] ?? "").split(/\s+/);
    expect(tokens).toContain("allow-scripts");
    expect(tokens).toContain("allow-forms");
    expect(tokens).not.toContain("allow-same-origin");
    // Templates may link out (e.g. a demo index → other panes) via a
    // user-activated top navigation, but must not be able to spawn popups or
    // run at a real origin.
    expect(tokens).toContain("allow-top-navigation-by-user-activation");
    expect(tokens).not.toContain("allow-popups");
    // `allow="clipboard-write"` is a Permissions-Policy delegation (not a
    // sandbox token) that lets a template copy to the clipboard on a user
    // gesture — e.g. a "copy this" button. Write-only; no clipboard read.
    const allowMatch = body.match(/<iframe[^>]*\sallow="([^"]+)"/);
    expect(allowMatch).not.toBeNull();
    expect(allowMatch![1]).toContain("clipboard-write");
  });

  it("renders the closed banner and no iframe for a closed pane", async () => {
    const { token } = await seedPane({ closed: true });
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('class="closed"');
    expect(body).toContain("This pane is closed");
    expect(body).not.toContain("<iframe");
  });

  it("renders the pane title into the tab <title>", async () => {
    const { token } = await seedPane({ title: "Quarterly Review · Pane" });
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).toContain("<title>Quarterly Review · Pane</title>");
    // The old hardcoded text must not leak back in.
    expect(body).not.toContain("<title>Pane Pane</title>");
    expect(body).not.toContain("<title>Pane — Pane</title>");
  });

  it("HTML-escapes the title so an agent-supplied <script> cannot break out", async () => {
    // The title field is filtered for control chars at pane create, but
    // `<script>alert(1)</script>` is otherwise valid text. It must never reach
    // the HTML stream unescaped.
    const { token } = await seedPane({ title: "<script>alert(1)</script>" });
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain(
      "<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>",
    );
  });

  it("includes a relay-controlled favicon link in the live shell", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).toMatch(
      /<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="data:image\/svg\+xml,/,
    );
  });

  it("includes the same favicon link in the closed-pane shell", async () => {
    const { token } = await seedPane({ closed: true });
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).toMatch(
      /<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="data:image\/svg\+xml,/,
    );
  });

  it("404s on a malformed token", async () => {
    const res = await app.fetch(new Request("http://t/s/not-a-real-token"));
    expect(res.status).toBe(404);
  });

  it("404s on a well-formed but unknown token", async () => {
    const bogus = generateHumanParticipantToken();
    const res = await app.fetch(new Request(`http://t/s/${bogus}`));
    expect(res.status).toBe(404);
  });
});

describe("bridge content GET /s/:token/content", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  const MARKER = '<div id="art">MARKER</div>';

  it("returns 200 text/html for a valid open pane", async () => {
    const { token } = await seedPane({ templateSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("sets a sandboxed CSP for the template frame", async () => {
    const { token } = await seedPane({ templateSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'self'");
    // connect-src stays locked so fetch/XHR/WebSocket can't exfiltrate.
    expect(csp).toContain("connect-src 'none'");
  });

  it("allows the relay origin in img-src/media-src for /b/<token> capability URLs", async () => {
    const { token } = await seedPane({ templateSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    const csp = res.headers.get("content-security-policy") ?? "";
    // PUBLIC_URL is http://localhost:3000 in this suite's setup.
    expect(csp).toContain("img-src data: http://localhost:3000");
    expect(csp).toContain("media-src http://localhost:3000");
    // `attachment:` has no handler — it must NOT advertise a dead path.
    expect(csp).not.toContain("attachment:");
    // The capability token lands in <img src>; keep it out of any Referer.
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("embeds the template body and the pane runtime", async () => {
    const { token } = await seedPane({ templateSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    const body = await res.text();
    expect(body).toContain(MARKER);
    // Stable substrings from runtime.client.ts: it assigns `window.pane`
    // and tags every frame with `__pane`.
    expect(body).toContain("window.pane");
    expect(body).toContain("__pane");
  });

  it("does not set X-Frame-Options (unlike the shell route)", async () => {
    const { token } = await seedPane({ templateSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("returns 410 for a closed pane", async () => {
    const { token } = await seedPane({ closed: true });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.status).toBe(410);
  });

  it("returns 410 for an expired pane", async () => {
    const { token } = await seedPane({ expired: true });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.status).toBe(410);
  });

  it("404s on a malformed token", async () => {
    const res = await app.fetch(
      new Request("http://t/s/not-a-real-token/content"),
    );
    expect(res.status).toBe(404);
  });

  it("injects the default artifact stylesheet into <head> by default", async () => {
    const { token } = await seedPane({ templateSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    const body = await res.text();
    // A stable token unique to default-styles.ts — picks up if injection ran.
    expect(body).toContain("--pane-accent");
    // Injected in <head>, so author <style> in the body wins the cascade.
    const styleIdx = body.indexOf("--pane-accent");
    const markerIdx = body.indexOf(MARKER);
    expect(styleIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeGreaterThan(styleIdx);
  });

  it("skips default-style injection when the artifact opts out via data-pane-bare", async () => {
    const { token } = await seedPane({
      templateSource: "<html data-pane-bare><body>raw</body></html>",
    });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    const body = await res.text();
    expect(body).not.toContain("--pane-accent");
    expect(body).toContain("data-pane-bare");
  });

  it("lets author <style> rules override defaults (cascade order)", async () => {
    // Author rule comes AFTER the pane <head> block, so at equal specificity
    // the author wins. We assert the rule is present in the rendered HTML;
    // the actual cascade is a browser concern but document-order is the
    // contract we expose.
    const { token } = await seedPane({
      templateSource:
        "<style>button { background: red; }</style><button>x</button>",
    });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    const body = await res.text();
    expect(body).toContain("--pane-accent");
    const paneStyleIdx = body.indexOf("--pane-accent");
    const authorStyleIdx = body.indexOf("button { background: red; }");
    expect(authorStyleIdx).toBeGreaterThan(paneStyleIdx);
  });
});

// The bridge is the human-facing entry point. When a person opens a stale
// link in a browser they should see a styled HTML page, not the JSON error
// envelope the /v1/* API uses. Agents and curl (Accept: */*) keep getting
// JSON so existing automation/tests don't change shape.
describe("bridge human-facing error pages", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  const HTML_ACCEPT =
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

  describe("GET /s/:token", () => {
    it("returns an HTML 404 page for an unknown token when Accept prefers HTML", async () => {
      const bogus = generateHumanParticipantToken();
      const res = await app.fetch(
        new Request(`http://t/s/${bogus}`, {
          headers: { Accept: HTML_ACCEPT },
        }),
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain("This pane link");
      // The failed token MUST NOT be baked into the rendered page — that
      // would leak tokens into screenshots, logs, and bug-report copy/paste.
      expect(body).not.toContain(bogus);
    });

    it("returns the JSON envelope for an unknown token when Accept is application/json", async () => {
      const bogus = generateHumanParticipantToken();
      const res = await app.fetch(
        new Request(`http://t/s/${bogus}`, {
          headers: { Accept: "application/json" },
        }),
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    });

    it("returns the JSON envelope when no Accept header is sent (curl default)", async () => {
      const bogus = generateHumanParticipantToken();
      const res = await app.fetch(new Request(`http://t/s/${bogus}`));
      // fetch implementations typically default to */* — which falls through
      // to JSON so existing CLI/agent code that never sets Accept keeps the
      // structured envelope.
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("returns the JSON envelope for a malformed token regardless of Accept (when JSON), HTML otherwise", async () => {
      const malformed = "not-a-real-token";
      const html = await app.fetch(
        new Request(`http://t/s/${malformed}`, {
          headers: { Accept: HTML_ACCEPT },
        }),
      );
      expect(html.status).toBe(404);
      expect(html.headers.get("content-type")).toContain("text/html");

      const json = await app.fetch(
        new Request(`http://t/s/${malformed}`, {
          headers: { Accept: "application/json" },
        }),
      );
      expect(json.status).toBe(404);
      expect(json.headers.get("content-type")).toContain("application/json");
    });

    it("inlines the brand favicon and uses a status-aware title", async () => {
      const bogus = generateHumanParticipantToken();
      const res = await app.fetch(
        new Request(`http://t/s/${bogus}`, {
          headers: { Accept: HTML_ACCEPT },
        }),
      );
      const body = await res.text();
      // Favicon — inlined as an SVG data URI so the relay needs no static
      // asset pipeline. The exact href is brittle; just assert the link tag
      // and that it carries an svg+xml data URI.
      expect(body).toMatch(
        /<link\s+rel="icon"[^>]+href="data:image\/svg\+xml,/,
      );
      // Title carries the brand + the page-specific copy so the tab is
      // identifiable when a user has many open.
      expect(body).toMatch(/<title>Pane — Not found<\/title>/);
    });

    it("sets the same defence-in-depth security headers as the shell", async () => {
      const bogus = generateHumanParticipantToken();
      const res = await app.fetch(
        new Request(`http://t/s/${bogus}`, {
          headers: { Accept: HTML_ACCEPT },
        }),
      );
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
    });

    it("renders the shell with its inline closed banner for an expired pane (200, not 410)", async () => {
      // For the /:token shell route an expired/closed pane doesn't throw —
      // loadByToken succeeds, isClosed is computed, and the shell renders a
      // banner instead of the iframe. The /content route below is where the
      // gone() path lives; the issue's acceptance criterion notes this
      // asymmetry is fine as long as the two routes stay coherent.
      const { token } = await seedPane({ expired: true });
      const res = await app.fetch(
        new Request(`http://t/s/${token}`, {
          headers: { Accept: HTML_ACCEPT },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("This pane is closed");
    });
  });

  describe("GET /s/:token/content", () => {
    it("returns an HTML 410 page for a closed pane when Accept prefers HTML", async () => {
      const { token } = await seedPane({ closed: true });
      const res = await app.fetch(
        new Request(`http://t/s/${token}/content`, {
          headers: { Accept: HTML_ACCEPT },
        }),
      );
      expect(res.status).toBe(410);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("This pane has been closed");
      expect(body).not.toContain(token);
    });

    it("returns an HTML 410 page for an expired pane when Accept prefers HTML", async () => {
      const { token } = await seedPane({ expired: true });
      const res = await app.fetch(
        new Request(`http://t/s/${token}/content`, {
          headers: { Accept: HTML_ACCEPT },
        }),
      );
      expect(res.status).toBe(410);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("This pane has been closed");
    });

    it("returns an HTML 404 page for an unknown token's /content when Accept prefers HTML", async () => {
      const bogus = generateHumanParticipantToken();
      const res = await app.fetch(
        new Request(`http://t/s/${bogus}/content`, {
          headers: { Accept: HTML_ACCEPT },
        }),
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("This pane link");
    });

    it("returns the JSON envelope for a closed pane when Accept is application/json", async () => {
      const { token } = await seedPane({ closed: true });
      const res = await app.fetch(
        new Request(`http://t/s/${token}/content`, {
          headers: { Accept: "application/json" },
        }),
      );
      expect(res.status).toBe(410);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("gone");
    });

    it("returns the JSON envelope for an unknown token's /content with no Accept header", async () => {
      const bogus = generateHumanParticipantToken();
      const res = await app.fetch(new Request(`http://t/s/${bogus}/content`));
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });
});

describe("bridge GET /s/:token/icon.png (home-screen icon)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("serves a 180x180 PNG — the robot default for a pane with no icon", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}/icon.png`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic number — proves real raster bytes, not an HTML/JSON body.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("honours If-None-Match with a 304", async () => {
    const { token } = await seedPane();
    const first = await app.fetch(new Request(`http://t/s/${token}/icon.png`));
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await app.fetch(
      new Request(`http://t/s/${token}/icon.png`, {
        headers: { "if-none-match": etag as string },
      }),
    );
    expect(second.status).toBe(304);
  });

  it("404s for a well-formed but unknown token", async () => {
    const bogus = generateHumanParticipantToken();
    const res = await app.fetch(new Request(`http://t/s/${bogus}/icon.png`));
    expect(res.status).toBe(404);
  });

  it("the viewer shell links this pane's own apple-touch-icon", async () => {
    const { token } = await seedPane();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const html = await res.text();
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain(`href="/s/${token}/icon.png"`);
  });
});
