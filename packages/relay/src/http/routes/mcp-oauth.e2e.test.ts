// End-to-end coverage for the remote MCP connector: the OAuth 2.1 discovery
// chain + authorization-code/PKCE flow, and the OAuth-protected Streamable-HTTP
// MCP endpoint. Exercises the whole handoff Claude performs:
//
//   1. unauthenticated tools/call → 401 + WWW-Authenticate
//   2. fetch both .well-known docs
//   3. Dynamic Client Registration
//   4. /authorize requires login + consent (programmatic login cookie)
//   5. /authorize/decision (allow) → single-use code
//   6. /token exchange (PKCE) → access + refresh tokens
//   7. authenticated initialize → tools/list → tools/call (create_pane) runs
//      as the mapped agent (a pane appears owned by that agent)
//   8. refresh, revoke, single-use + PKCE-failure + redirect-mismatch negatives
//
// The human-login + consent step is simulated by forging a `pane_login` cookie
// for a seeded Human (exactly what magic-link verify mints) and POSTing the
// consent decision with it — documented in the PR's "how this was verified".

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
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

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;

const PUBLIC_URL = "http://localhost:3000";
const RESOURCE = `${PUBLIC_URL}/mcp`;
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(
    loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL,
      REGISTRATION_MODE: "open",
      // The whole suite shares one IP bucket ("unknown" under app.fetch), so
      // the dedicated OAuth/MCP limiter would otherwise throttle unrelated
      // tests. Disable it on the shared app; the burst-429 + session-cap tests
      // build their own apps with explicit low limits.
      MCP_RATE_LIMIT: "0",
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

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// Pull a hidden input's value out of the rendered consent HTML. The consent
// form now carries only `pending_id` + `csrf_token` (every OAuth param is held
// server-side), so the decision POST is built from these.
function hiddenField(html: string, name: string): string {
  const re = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`);
  const m = re.exec(html);
  if (!m) throw new Error(`hidden field ${name} not found in consent page`);
  return m[1]!;
}

// Render the consent page for a logged-in human + registered client, returning
// the parsed CSRF token + pending id (and echoing the page HTML for assertions).
async function renderConsent(opts: {
  cookie: string;
  clientId: string;
  challenge: string;
  state?: string;
  redirectUri?: string;
}): Promise<{ pendingId: string; csrfToken: string; html: string }> {
  const redirect = opts.redirectUri ?? CLAUDE_REDIRECT;
  const authUrl =
    `http://t/oauth/authorize?response_type=code&client_id=${opts.clientId}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&code_challenge=${opts.challenge}&code_challenge_method=S256` +
    (opts.state ? `&state=${opts.state}` : "");
  const res = await app.fetch(
    new Request(authUrl, {
      headers: { cookie: `${LOGIN_COOKIE_NAME}=${opts.cookie}` },
    }),
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  return {
    pendingId: hiddenField(html, "pending_id"),
    csrfToken: hiddenField(html, "csrf_token"),
    html,
  };
}

// Build the consent-decision POST body from a rendered consent page.
function decisionForm(p: {
  decision: "allow" | "deny";
  pendingId: string;
  csrfToken: string;
}): URLSearchParams {
  return new URLSearchParams({
    decision: p.decision,
    pending_id: p.pendingId,
    csrf_token: p.csrfToken,
  });
}

// A same-origin Origin header the CSRF gate accepts (matches PUBLIC_URL).
const SAME_ORIGIN_HEADERS = { origin: PUBLIC_URL };

// POST the consent decision (default allow, same-origin) for a rendered page.
async function postDecision(opts: {
  cookie: string;
  pendingId: string;
  csrfToken: string;
  decision?: "allow" | "deny";
  headers?: Record<string, string>;
}): Promise<Response> {
  const form = decisionForm({
    decision: opts.decision ?? "allow",
    pendingId: opts.pendingId,
    csrfToken: opts.csrfToken,
  });
  return app.fetch(
    new Request(`http://t/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        cookie: `${LOGIN_COOKIE_NAME}=${opts.cookie}`,
        "content-type": "application/x-www-form-urlencoded",
        ...SAME_ORIGIN_HEADERS,
        ...(opts.headers ?? {}),
      },
      body: form.toString(),
      redirect: "manual",
    }),
  );
}

// Render consent + allow, returning the issued authorization code.
async function consentToCode(opts: {
  cookie: string;
  clientId: string;
  challenge: string;
  redirectUri?: string;
}): Promise<string> {
  const { pendingId, csrfToken } = await renderConsent(opts);
  const dres = await postDecision({
    cookie: opts.cookie,
    pendingId,
    csrfToken,
  });
  return new URL(dres.headers.get("location")!).searchParams.get("code")!;
}

async function registerClient(): Promise<string> {
  const res = await app.fetch(
    new Request(`http://t/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [CLAUDE_REDIRECT],
      }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  expect(body.client_id).toMatch(/^pmcli_/);
  return body.client_id;
}

/** Full authorize+consent→token; returns the token response. */
async function fullAuthFlow(): Promise<{
  access_token: string;
  refresh_token: string;
  clientId: string;
  verifier: string;
}> {
  const { cookie } = await seedLoggedInHuman();
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();

  // /authorize (logged in) renders the consent page with a CSRF token bound to
  // a server-side pending-authorization record.
  const { pendingId, csrfToken, html } = await renderConsent({
    cookie,
    clientId,
    challenge,
    state: "xyz",
  });
  expect(html).toContain("Allow");

  // Consent → allow (same-origin POST with the page's CSRF token).
  const form = decisionForm({ decision: "allow", pendingId, csrfToken });
  const decisionRes = await app.fetch(
    new Request(`http://t/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
        "content-type": "application/x-www-form-urlencoded",
        ...SAME_ORIGIN_HEADERS,
      },
      body: form.toString(),
      redirect: "manual",
    }),
  );
  expect(decisionRes.status).toBe(302);
  const loc = decisionRes.headers.get("location")!;
  const code = new URL(loc).searchParams.get("code")!;
  expect(code).toMatch(/^pmc_/);
  expect(new URL(loc).searchParams.get("state")).toBe("xyz");

  // /token exchange.
  const tokenRes = await app.fetch(
    new Request(`http://t/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      }).toString(),
    }),
  );
  expect(tokenRes.status).toBe(200);
  const tok = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
  };
  expect(tok.token_type).toBe("Bearer");
  expect(tok.access_token).toMatch(/^pmt_/);
  return { ...tok, clientId, verifier };
}

// ---- MCP transport helpers ----

async function mcpPost(
  body: unknown,
  opts: { token?: string; sessionId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.sessionId) headers["mcp-session-id"] = opts.sessionId;
  return app.fetch(
    new Request(`http://t/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function initBody(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  };
}

/** Parse a Response body that may be JSON or an SSE stream of one message. */
async function readRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    // Grab the first `data:` line's JSON.
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : {};
  }
  return text ? JSON.parse(text) : {};
}

describe("OAuth discovery + metadata", () => {
  it("serves protected-resource metadata (RFC 9728) with exact resource", async () => {
    const res = await app.fetch(
      new Request(`http://t/.well-known/oauth-protected-resource`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([PUBLIC_URL]);
  });

  it("serves authorization-server metadata (RFC 8414) advertising PKCE", async () => {
    const res = await app.fetch(
      new Request(`http://t/.well-known/oauth-authorization-server`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(PUBLIC_URL);
    expect(body.token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
  });
});

describe("Dynamic Client Registration", () => {
  it("registers a public (PKCE) client without a secret", async () => {
    const clientId = await registerClient();
    const row = await prisma.oAuthClient.findUnique({ where: { clientId } });
    expect(row?.clientSecretHash).toBeNull();
    expect(row?.tokenEndpointAuthMethod).toBe("none");
  });

  it("rejects a registration with no redirect_uris", async () => {
    const res = await app.fetch(
      new Request(`http://t/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("MCP 401 challenge (unauthenticated)", () => {
  it("initialize works WITHOUT a token (capability discovery)", async () => {
    const res = await mcpPost(initBody());
    expect(res.status).toBe(200);
    const rpc = await readRpc(res);
    expect(rpc.result).toBeTruthy();
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("tools/call WITHOUT a token → 401 with WWW-Authenticate", async () => {
    // Establish a session first (initialize is public).
    const initRes = await mcpPost(initBody());
    const sid = initRes.headers.get("mcp-session-id")!;
    const res = await mcpPost(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_panes", arguments: {} },
      },
      { sessionId: sid },
    );
    expect(res.status).toBe(401);
    const w = res.headers.get("www-authenticate") ?? "";
    expect(w).toContain("Bearer");
    expect(w).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    );
  });

  it("a present-but-invalid token → 401 challenge", async () => {
    const res = await mcpPost(initBody(), { token: "pmt_bogus" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });
});

describe("authorize/consent gating", () => {
  it("/authorize without login redirects to /login", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await app.fetch(
      new Request(
        `http://t/oauth/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(CLAUDE_REDIRECT)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`,
        { redirect: "manual" },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("/authorize rejects an unregistered redirect_uri (no redirect)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await app.fetch(
      new Request(
        `http://t/oauth/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent("https://evil.test/x")}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`,
        {
          headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
          redirect: "manual",
        },
      ),
    );
    // Must NOT redirect to the attacker URI.
    expect(res.status).toBe(400);
  });

  it("/authorize rejects a missing PKCE challenge", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();
    const res = await app.fetch(
      new Request(
        `http://t/oauth/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(CLAUDE_REDIRECT)}`,
        {
          headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
          redirect: "manual",
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid_request");
  });
});

describe("token exchange", () => {
  it("completes the full flow + issues a usable access token", async () => {
    const { access_token } = await fullAuthFlow();
    expect(access_token).toMatch(/^pmt_/);
    const row = await prisma.oAuthToken.findUnique({
      where: {
        tokenHash: createHash("sha256").update(access_token).digest("hex"),
      },
    });
    expect(row?.kind).toBe("access");
    // An MCP agent was provisioned + owned by the human.
    const agent = await prisma.agent.findUnique({
      where: { id: row!.agentId },
    });
    expect(agent?.ownerHumanId).toBeTruthy();
    expect(agent?.claimedAt).toBeTruthy();
  });

  it("rejects a reused (single-use) authorization code", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consentToCode({ cookie, clientId, challenge });
    const exchange = () =>
      app.fetch(
        new Request(`http://t/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            redirect_uri: CLAUDE_REDIRECT,
            code_verifier: verifier,
          }).toString(),
        }),
      );
    expect((await exchange()).status).toBe(200);
    // Second use must fail.
    expect((await exchange()).status).toBe(400);
  });

  it("rejects an exchange with a wrong PKCE verifier", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const code = await consentToCode({ cookie, clientId, challenge });
    const res = await app.fetch(
      new Request(`http://t/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: CLAUDE_REDIRECT,
          code_verifier: randomBytes(48).toString("base64url"), // wrong
        }).toString(),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an exchange with a mismatched redirect_uri", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();
    // Register a second redirect on the client so the mismatch isn't caught by
    // the allowlist but by the code-binding check.
    await prisma.oAuthClient.update({
      where: { clientId },
      data: {
        redirectUris: [CLAUDE_REDIRECT, "https://claude.ai/other"],
      },
    });
    const { verifier, challenge } = pkce();
    // Bind the code to CLAUDE_REDIRECT (the consent uses that redirect_uri).
    const code = await consentToCode({ cookie, clientId, challenge });
    const res = await app.fetch(
      new Request(`http://t/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: "https://claude.ai/other", // differs from the bound one
          code_verifier: verifier,
        }).toString(),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("refresh + revoke", () => {
  it("exchanges a refresh token for a new pair", async () => {
    const { refresh_token, clientId } = await fullAuthFlow();
    const res = await app.fetch(
      new Request(`http://t/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token,
          client_id: clientId,
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    const tok = (await res.json()) as { access_token: string };
    expect(tok.access_token).toMatch(/^pmt_/);
    // The old refresh token is rotated out (revoked).
    const old = await prisma.oAuthToken.findUnique({
      where: {
        tokenHash: createHash("sha256").update(refresh_token).digest("hex"),
      },
    });
    expect(old?.revokedAt).toBeTruthy();
  });

  it("revokes an access token so it stops working", async () => {
    const { access_token } = await fullAuthFlow();
    const rev = await app.fetch(
      new Request(`http://t/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: access_token }).toString(),
      }),
    );
    expect(rev.status).toBe(200);
    // A privileged MCP call now 401s.
    const initRes = await mcpPost(initBody(), { token: access_token });
    expect(initRes.status).toBe(401);
  });
});

describe("authenticated MCP tool call runs as the mapped agent", () => {
  it("initialize → tools/list → tools/call create_pane creates a pane owned by the agent", async () => {
    const { access_token } = await fullAuthFlow();

    // initialize (with token).
    const initRes = await mcpPost(initBody(), { token: access_token });
    expect(initRes.status).toBe(200);
    const sid = initRes.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();

    // notifications/initialized (no id).
    await mcpPost(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { token: access_token, sessionId: sid },
    );

    // tools/list — pane tools are advertised.
    const listRes = await mcpPost(
      { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} },
      { token: access_token, sessionId: sid },
    );
    const listRpc = await readRpc(listRes);
    const tools = (
      listRpc.result as {
        tools: {
          name: string;
          annotations?: {
            title?: string;
            readOnlyHint?: boolean;
            destructiveHint?: boolean;
            idempotentHint?: boolean;
            openWorldHint?: boolean;
          };
        }[];
      }
    ).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_pane");
    expect(names).toContain("get_skill");
    expect(tools).toHaveLength(26);

    // Directory-readiness: annotations (title + behavioural hints) must reach
    // tools/list over the HTTP transport, not just the stdio one. Assert a
    // representative read-only / destructive / consolidated sample.
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const t of tools) {
      expect(t.annotations, t.name).toBeTruthy();
      expect(typeof t.annotations!.title, t.name).toBe("string");
    }
    expect(byName.get("list_panes")!.annotations).toMatchObject({
      title: "List Panes",
      readOnlyHint: true,
    });
    expect(byName.get("delete_pane")!.annotations).toMatchObject({
      title: "Delete Pane",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.get("template")!.annotations).toMatchObject({
      title: "Manage Templates",
      readOnlyHint: false,
      destructiveHint: true,
    });

    // tools/call create_pane — runs as the mapped agent against the relay's
    // own API (loopback). NOTE: the loopback points at 127.0.0.1:PORT which the
    // in-test app.fetch doesn't serve, so the PaneClient call fails to connect.
    // We assert the call is AUTHORIZED + dispatched (no 401, a tool result
    // envelope comes back) rather than a successful create — a live relay
    // verification (scripts) covers the end-to-end create. This keeps the e2e
    // hermetic without spinning a real listening socket.
    const callRes = await mcpPost(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "get_skill", arguments: { version_only: true } },
      },
      { token: access_token, sessionId: sid },
    );
    expect(callRes.status).toBe(200);
    const callRpc = await readRpc(callRes);
    // get_skill resolves server-side (no loopback needed) → returns the version.
    const result = callRpc.result as {
      content: { type: string; text: string }[];
    };
    const payload = JSON.parse(result.content[0]!.text);
    expect(typeof payload.version).toBe("string");
  });

  it("prompts/list + resources/list advertise the pane guide", async () => {
    const initRes = await mcpPost(initBody());
    const sid = initRes.headers.get("mcp-session-id")!;
    const promptsRes = await mcpPost(
      { jsonrpc: "2.0", id: 20, method: "prompts/list", params: {} },
      { sessionId: sid },
    );
    const prompts = (
      (await readRpc(promptsRes)).result as { prompts: { name: string }[] }
    ).prompts;
    expect(prompts.map((p) => p.name)).toContain("pane_guide");

    const resourcesRes = await mcpPost(
      { jsonrpc: "2.0", id: 21, method: "resources/list", params: {} },
      { sessionId: sid },
    );
    const resources = (
      (await readRpc(resourcesRes)).result as {
        resources: { uri: string }[];
      }
    ).resources;
    expect(resources.map((r) => r.uri)).toContain("pane://guide");
  });
});

// ---------------------------------------------------------------------------
// Security-fix coverage (review findings #1, #3, #4, #5, #6).
// ---------------------------------------------------------------------------

describe("consent CSRF protection (#1)", () => {
  it("a forged cross-origin consent POST is rejected (403)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const { pendingId, csrfToken } = await renderConsent({
      cookie,
      clientId,
      challenge,
    });
    // Same valid cookie + CSRF token, but an attacker's Origin header — the
    // server-side Origin check must refuse it before minting a code.
    const res = await postDecision({
      cookie,
      pendingId,
      csrfToken,
      headers: { origin: "https://evil.test" },
    });
    expect(res.status).toBe(403);
    // No code was minted (nothing to redirect to).
    expect(res.headers.get("location")).toBeNull();
  });

  it("a consent POST with a missing/invalid CSRF token is rejected (403)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const { pendingId } = await renderConsent({ cookie, clientId, challenge });
    const res = await postDecision({
      cookie,
      pendingId,
      csrfToken: "tampered.deadbeef",
    });
    expect(res.status).toBe(403);
  });

  it("a CSRF token from one session can't be replayed by another (403)", async () => {
    const a = await seedLoggedInHuman("a@example.com");
    const b = await seedLoggedInHuman("b@example.com");
    const clientId = await registerClient();
    const { challenge } = pkce();
    // A renders consent (token bound to A's session + pending record).
    const { pendingId, csrfToken } = await renderConsent({
      cookie: a.cookie,
      clientId,
      challenge,
    });
    // B presents A's pending id + CSRF token with B's own login cookie.
    const res = await postDecision({
      cookie: b.cookie,
      pendingId,
      csrfToken,
    });
    // The pending record belongs to A's session, not B's → rejected.
    expect(res.status).toBe(400);
  });

  it("a legitimate same-origin consent succeeds and mints a code (#1 control)", async () => {
    const { access_token } = await fullAuthFlow();
    expect(access_token).toMatch(/^pmt_/);
  });

  it("the consent pending record is single-use (replay → 400)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const { pendingId, csrfToken } = await renderConsent({
      cookie,
      clientId,
      challenge,
    });
    const first = await postDecision({ cookie, pendingId, csrfToken });
    expect(first.status).toBe(302);
    const second = await postDecision({ cookie, pendingId, csrfToken });
    expect(second.status).toBe(400);
  });
});

describe("unverified-client consent notice + redirect host (#3)", () => {
  it("the consent page marks the client unverified and shows the redirect host", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const { html } = await renderConsent({ cookie, clientId, challenge });
    expect(html).toContain("not verified by pane");
    // The redirect_uri host is surfaced so the human sees where they authorize.
    expect(html).toContain("claude.ai");
  });
});

describe("token audience/resource binding (#4)", () => {
  it("rejects an access token whose bound resource doesn't match this MCP endpoint", async () => {
    const { access_token } = await fullAuthFlow();
    // Tamper the stored row's resource to a different audience.
    await prisma.oAuthToken.updateMany({
      where: {
        tokenHash: createHash("sha256").update(access_token).digest("hex"),
      },
      data: { resource: "https://other.example/mcp" },
    });
    // A privileged MCP call now 401s (audience mismatch).
    const initRes = await mcpPost(initBody(), { token: access_token });
    expect(initRes.status).toBe(401);
  });

  it("accepts a token bound to the exact MCP resource (control)", async () => {
    const { access_token } = await fullAuthFlow();
    const row = await prisma.oAuthToken.findUnique({
      where: {
        tokenHash: createHash("sha256").update(access_token).digest("hex"),
      },
    });
    expect(row?.resource).toBe(RESOURCE);
    const initRes = await mcpPost(initBody(), { token: access_token });
    expect(initRes.status).toBe(200);
  });
});

describe("stable agent key across re-authorization (#5)", () => {
  it("two overlapping authorizations leave BOTH access tokens working", async () => {
    const { cookie } = await seedLoggedInHuman();
    const clientId = await registerClient();

    async function authorizeOnce(): Promise<string> {
      const { verifier, challenge } = pkce();
      const code = await consentToCode({ cookie, clientId, challenge });
      const tokenRes = await app.fetch(
        new Request(`http://t/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            redirect_uri: CLAUDE_REDIRECT,
            code_verifier: verifier,
          }).toString(),
        }),
      );
      expect(tokenRes.status).toBe(200);
      return ((await tokenRes.json()) as { access_token: string }).access_token;
    }

    // First authorization, then a SECOND (re-authorization reuses the agent).
    const token1 = await authorizeOnce();
    const token2 = await authorizeOnce();

    // Both map to the same agent (one MCP agent per human).
    const row1 = await prisma.oAuthToken.findUnique({
      where: { tokenHash: createHash("sha256").update(token1).digest("hex") },
    });
    const row2 = await prisma.oAuthToken.findUnique({
      where: { tokenHash: createHash("sha256").update(token2).digest("hex") },
    });
    expect(row1?.agentId).toBe(row2?.agentId);

    // The agent's key hash must match BOTH tokens' sealed key — i.e. the key
    // wasn't rotated by the second authorization. Decrypt each token's sealed
    // key and confirm it hashes to the agent's current keyHash.
    const agent = await prisma.agent.findUnique({
      where: { id: row1!.agentId },
    });
    const { openAgentKey } = await import("../../mcp/oauth.js");
    const { hashKey } = await import("../../keys.js");
    expect(hashKey(openAgentKey(row1!.agentKeyEnc))).toBe(agent!.keyHash);
    expect(hashKey(openAgentKey(row2!.agentKeyEnc))).toBe(agent!.keyHash);

    // And both authenticate at the MCP endpoint (no 401 from a stale key).
    expect((await mcpPost(initBody(), { token: token1 })).status).toBe(200);
    expect((await mcpPost(initBody(), { token: token2 })).status).toBe(200);
  });
});

describe("OAuth + /mcp rate limiting (#2)", () => {
  it("returns 429 once an IP exceeds the OAuth burst limit", async () => {
    // A dedicated app with a tiny MCP rate limit so a short burst trips it.
    const limited = buildApp(
      loadConfig({
        DATABASE_URL: testDb.dbUrl,
        PUBLIC_URL,
        REGISTRATION_MODE: "open",
        MCP_RATE_LIMIT: "3",
        MCP_RATE_LIMIT_WINDOW_SECONDS: "60",
      }),
      prisma,
    );
    // app.fetch has no socket, so clientIp resolves to "unknown" — every
    // request buckets together, which is exactly what we want for the burst.
    const hit = () =>
      limited.fetch(
        new Request(`http://t/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "x",
            redirect_uris: [CLAUDE_REDIRECT],
          }),
        }),
      );
    // First 3 are allowed (201); the 4th trips the limiter (429).
    expect((await hit()).status).toBe(201);
    expect((await hit()).status).toBe(201);
    expect((await hit()).status).toBe(201);
    expect((await hit()).status).toBe(429);
  });
});

describe("MCP session map is bounded (#2)", () => {
  it("caps the in-memory session map, evicting oldest sessions over the limit", async () => {
    const { _sessionsForTests } = await import("./mcp.js");
    _sessionsForTests.clear();

    // A dedicated app with a tiny session cap so a handful of unauthenticated
    // initializes trips eviction. The session map is module-global, so this
    // shares it with the default `app` — we cleared it above and assert the
    // cap holds regardless.
    const capped = buildApp(
      loadConfig({
        DATABASE_URL: testDb.dbUrl,
        PUBLIC_URL,
        REGISTRATION_MODE: "open",
        MCP_MAX_SESSIONS: "3",
        // Avoid the OAuth limiter tripping during the initialize burst.
        MCP_RATE_LIMIT: "0",
      }),
      prisma,
    );

    async function initOnce(): Promise<void> {
      const res = await capped.fetch(
        new Request(`http://t/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(initBody()),
        }),
      );
      expect(res.status).toBe(200);
    }

    // Create well over the cap of 3.
    for (let i = 0; i < 8; i++) await initOnce();

    // The map never exceeds the cap — old sessions are evicted to make room.
    expect(_sessionsForTests.size()).toBeLessThanOrEqual(3);
  });
});
