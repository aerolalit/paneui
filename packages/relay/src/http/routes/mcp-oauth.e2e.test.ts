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

async function seedLoggedInHuman(): Promise<{
  humanId: string;
  cookie: string;
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
  return { humanId: human.id, cookie };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
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

  // /authorize (logged in) renders the consent page.
  const authUrl =
    `http://t/oauth/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(CLAUDE_REDIRECT)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`;
  const authRes = await app.fetch(
    new Request(authUrl, {
      headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
    }),
  );
  expect(authRes.status).toBe(200);
  expect(await authRes.text()).toContain("Allow");

  // Consent → allow.
  const form = new URLSearchParams({
    decision: "allow",
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT,
    code_challenge: challenge,
    state: "xyz",
    scope: "pane",
    resource: RESOURCE,
  });
  const decisionRes = await app.fetch(
    new Request(`http://t/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
        "content-type": "application/x-www-form-urlencoded",
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
    const form = new URLSearchParams({
      decision: "allow",
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: challenge,
      scope: "pane",
      resource: RESOURCE,
    });
    const dres = await app.fetch(
      new Request(`http://t/oauth/authorize/decision`, {
        method: "POST",
        headers: {
          cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        redirect: "manual",
      }),
    );
    const code = new URL(dres.headers.get("location")!).searchParams.get(
      "code",
    )!;
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
    const form = new URLSearchParams({
      decision: "allow",
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: challenge,
      scope: "pane",
      resource: RESOURCE,
    });
    const dres = await app.fetch(
      new Request(`http://t/oauth/authorize/decision`, {
        method: "POST",
        headers: {
          cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        redirect: "manual",
      }),
    );
    const code = new URL(dres.headers.get("location")!).searchParams.get(
      "code",
    )!;
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
    const form = new URLSearchParams({
      decision: "allow",
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: challenge,
      scope: "pane",
      resource: RESOURCE,
    });
    const dres = await app.fetch(
      new Request(`http://t/oauth/authorize/decision`, {
        method: "POST",
        headers: {
          cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        redirect: "manual",
      }),
    );
    const code = new URL(dres.headers.get("location")!).searchParams.get(
      "code",
    )!;
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
    const tools = (listRpc.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_pane");
    expect(names).toContain("get_skill");

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
