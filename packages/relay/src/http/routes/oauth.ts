// Self-hosted OAuth 2.1 authorization server for the remote MCP connector.
//
// Native Hono routes (the MCP SDK's mcpAuthRouter is Express-only, so we
// hand-roll the endpoints to integrate with the relay's Hono app + reuse its
// magic-link login cookie for the human consent step). Endpoints:
//
//   GET  /.well-known/oauth-protected-resource        RFC 9728 (resource meta)
//   GET  /.well-known/oauth-authorization-server      RFC 8414 (AS metadata)
//   POST /oauth/register                              RFC 7591 (DCR)
//   GET  /oauth/authorize                             auth-code + PKCE + consent
//   POST /oauth/authorize/decision                    consent allow/deny
//   POST /oauth/token                                 code + refresh exchange
//   POST /oauth/revoke                                RFC 7009 (revocation)
//
// Discovery chain Claude follows: an unauthenticated tools/call on /mcp →
// 401 with WWW-Authenticate pointing at /.well-known/oauth-protected-resource
// (set in routes/mcp.ts) → that doc points at this AS's metadata → Claude does
// DCR, /authorize (human logs in + consents), then /token.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../../config.js";
import type { AppEnv } from "../env.js";
import { resolveHumanOptional } from "../../auth/human-auth.js";
import { LOGIN_COOKIE_NAME } from "../../auth/cookie.js";
import {
  generateAuthCode,
  generateClientId,
  generateClientSecret,
  generateOAuthToken,
  openAgentKey,
  provisionMcpAgent,
  redirectUriAllowed,
  sealAgentKey,
  sha256,
  verifyPkceS256,
} from "../../mcp/oauth.js";
import { log } from "../../log.js";

// The single scope this AS grants — full agent access, parity with a CLI key.
// A read-only split is a documented future enhancement; v1 keeps one scope.
const PANE_SCOPE = "pane";

// ---------------------------------------------------------------------------
// Metadata documents (served at the relay root, NOT under /v1).
// ---------------------------------------------------------------------------

/**
 * Register the two `.well-known` metadata routes on the root app. The resource
 * identifier (RFC 8707 audience) is `<publicUrl>/mcp` and MUST match exactly
 * what routes/mcp.ts advertises in WWW-Authenticate — no trailing-slash drift.
 */
export function registerOAuthMetadata(app: Hono<AppEnv>): void {
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const { publicUrl } = c.get("config");
    return c.json({
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      scopes_supported: [PANE_SCOPE],
      bearer_methods_supported: ["header"],
      resource_documentation: `${publicUrl}/skills/pane/MCP.md`,
    });
  });

  // Some clients append the resource path to the well-known prefix
  // (RFC 9728 §3.1: /.well-known/oauth-protected-resource/mcp). Serve the same
  // document there so either spelling resolves.
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    const { publicUrl } = c.get("config");
    return c.json({
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      scopes_supported: [PANE_SCOPE],
      bearer_methods_supported: ["header"],
      resource_documentation: `${publicUrl}/skills/pane/MCP.md`,
    });
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const { publicUrl } = c.get("config");
    return c.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      revocation_endpoint: `${publicUrl}/oauth/revoke`,
      scopes_supported: [PANE_SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_post",
      ],
    });
  });

  // Mirror under the /mcp-suffixed path some clients probe.
  app.get("/.well-known/oauth-authorization-server/mcp", (c) => {
    const { publicUrl } = c.get("config");
    return c.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      revocation_endpoint: `${publicUrl}/oauth/revoke`,
      scopes_supported: [PANE_SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_post",
      ],
    });
  });
}

// ---------------------------------------------------------------------------
// Authorization-server endpoints (mounted under /oauth).
// ---------------------------------------------------------------------------

const oauth = new Hono<AppEnv>();

// ----- Dynamic Client Registration (RFC 7591) -----------------------------

const registerBody = z.object({
  redirect_uris: z.array(z.string().url()).min(1),
  client_name: z.string().max(256).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_basic", "client_secret_post"])
    .optional(),
  scope: z.string().optional(),
});

oauth.post("/register", async (c) => {
  const prisma = c.get("prisma");
  let body: z.infer<typeof registerBody>;
  try {
    body = registerBody.parse(await c.req.json());
  } catch {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "expected { redirect_uris: string[], ... }",
      },
      400,
    );
  }

  const authMethod = body.token_endpoint_auth_method ?? "none";
  const clientId = generateClientId();
  // Confidential clients get a secret; public (PKCE) clients — Claude — do not.
  const secret = authMethod === "none" ? null : generateClientSecret();

  await prisma.oAuthClient.create({
    data: {
      clientId,
      clientSecretHash: secret ? sha256(secret) : null,
      clientName: body.client_name ?? null,
      redirectUris: body.redirect_uris,
      grantTypes: body.grant_types ?? ["authorization_code", "refresh_token"],
      tokenEndpointAuthMethod: authMethod,
      scope: body.scope ?? PANE_SCOPE,
    },
  });

  log.info("oauth client registered", {
    clientId,
    clientName: body.client_name,
    redirectCount: body.redirect_uris.length,
  });

  return c.json(
    {
      client_id: clientId,
      ...(secret ? { client_secret: secret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris,
      grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: authMethod,
      scope: body.scope ?? PANE_SCOPE,
    },
    201,
  );
});

// ----- Authorization endpoint (auth-code + PKCE + human consent) ----------

// Build the error-redirect back to the client per OAuth 2.1 (so a denial /
// failure lands in the client's flow rather than a relay error page).
function errorRedirect(
  redirectUri: string,
  error: string,
  state: string | undefined,
  description?: string,
): string {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return u.toString();
}

oauth.get("/authorize", resolveHumanOptional, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const q = c.req.query();

  const clientId = q["client_id"];
  const redirectUri = q["redirect_uri"];
  const responseType = q["response_type"];
  const codeChallenge = q["code_challenge"];
  const codeChallengeMethod = q["code_challenge_method"];
  const state = q["state"];
  const scope = q["scope"];
  const resource = q["resource"];

  // Validate the client + redirect_uri BEFORE we can safely redirect errors.
  // A bad client_id / unregistered redirect_uri must NOT redirect (that would
  // be the open-redirect we're defending against) — render an inline error.
  if (!clientId || !redirectUri) {
    return c.text("invalid_request: client_id and redirect_uri required", 400);
  }
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client) {
    return c.text("invalid_client: unknown client_id", 400);
  }
  if (!redirectUriAllowed(client.redirectUris, redirectUri)) {
    // Exact-match failure → do NOT redirect (open-redirect defence).
    return c.text("invalid_request: redirect_uri not registered", 400);
  }

  // From here, errors can be redirected to the (validated) redirect_uri.
  if (responseType !== "code") {
    return c.redirect(
      errorRedirect(
        redirectUri,
        "unsupported_response_type",
        state,
        "only response_type=code is supported",
      ),
    );
  }
  // PKCE REQUIRED — reject a missing/invalid challenge.
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return c.redirect(
      errorRedirect(
        redirectUri,
        "invalid_request",
        state,
        "PKCE with code_challenge_method=S256 is required",
      ),
    );
  }

  // Human consent: require a logged-in human. If not logged in, bounce to the
  // relay's existing magic-link login and return here afterwards (returnUrl).
  const human = c.get("human");
  if (!human) {
    const returnUrl =
      new URL(c.req.url).pathname +
      "?" +
      new URL(c.req.url).searchParams.toString();
    const loginUrl = `/login?returnUrl=${encodeURIComponent(returnUrl)}`;
    return c.redirect(loginUrl);
  }

  // Render a minimal consent screen. The "allow" POST carries the validated
  // params forward (signed implicitly by the login cookie requirement on the
  // decision route). We embed them as hidden fields.
  return c.html(
    consentPage({
      clientName: client.clientName ?? clientId,
      humanEmail: human.email,
      clientId,
      redirectUri,
      codeChallenge,
      state: state ?? "",
      scope: scope ?? PANE_SCOPE,
      resource: resource ?? `${config.publicUrl}/mcp`,
    }),
  );
});

const decisionBody = z.object({
  decision: z.enum(["allow", "deny"]),
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

oauth.post("/authorize/decision", resolveHumanOptional, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const human = c.get("human");
  if (!human) {
    // The consent decision requires the same login that rendered the screen.
    return c.text("unauthorized: log in to consent", 401);
  }

  let body: z.infer<typeof decisionBody>;
  try {
    body = decisionBody.parse(await c.req.parseBody());
  } catch {
    return c.text("invalid_request", 400);
  }

  const client = await prisma.oAuthClient.findUnique({
    where: { clientId: body.client_id },
  });
  if (!client || !redirectUriAllowed(client.redirectUris, body.redirect_uri)) {
    // Never redirect to an unvalidated URI.
    return c.text("invalid_request: client/redirect mismatch", 400);
  }

  if (body.decision === "deny") {
    return c.redirect(
      errorRedirect(body.redirect_uri, "access_denied", body.state),
    );
  }

  // ALLOW: provision (or reuse) the human's MCP agent, mint a single-use code
  // bound to client + redirect_uri + PKCE challenge + the agent.
  const { agent, apiKey } = await provisionMcpAgent(prisma, human.id);
  const code = generateAuthCode();
  await prisma.oAuthAuthCode.create({
    data: {
      codeHash: sha256(code),
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
      codeChallengeMethod: "S256",
      humanId: human.id,
      agentId: agent.id,
      scope: body.scope ?? PANE_SCOPE,
      resource: body.resource ?? `${config.publicUrl}/mcp`,
      expiresAt: new Date(
        Date.now() + config.MCP_OAUTH_CODE_TTL_SECONDS * 1000,
      ),
    },
  });

  // The plaintext agent key is sealed into the token at exchange time — stash
  // it transiently on the code row's encrypted scope? No: we re-provision (key
  // rotation) at exchange would invalidate prior tokens. Instead the exchange
  // seals THIS key, so carry it via the code: store it sealed on the code row's
  // resource-independent path. We reuse the auth code's agentId + re-seal at
  // exchange by reading the agent — but we only have the plaintext key HERE.
  // Seal it now and stash on the code via a dedicated column is cleanest, but
  // to avoid widening the code row we re-mint the key at exchange. Simpler and
  // correct: stash the sealed key in-memory keyed by codeHash for the short
  // code TTL. See pendingKeys below.
  pendingAgentKeys.set(sha256(code), sealAgentKey(apiKey));

  log.info("oauth code issued", {
    clientId: body.client_id,
    humanId: human.id,
    agentId: agent.id,
  });

  const u = new URL(body.redirect_uri);
  u.searchParams.set("code", code);
  if (body.state) u.searchParams.set("state", body.state);
  return c.redirect(u.toString());
});

// Short-lived in-memory map of codeHash -> sealed agent key. The sealed key is
// the agent's plaintext API key encrypted with PANE_SECRET_KEY (so even this
// in-memory value is ciphertext). Lives only for the code TTL between consent
// and token exchange; the exchange consumes it. A relay restart between the two
// loses it (the client just re-authorizes) — acceptable for a single-replica
// container. Multi-replica hosting should move this to the code row; noted in
// the PR as a follow-up.
const pendingAgentKeys = new Map<string, string>();

// ----- Token endpoint (code + refresh exchange) ---------------------------

oauth.post("/token", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const form = await c.req.parseBody();
  const grantType = String(form["grant_type"] ?? "");

  if (grantType === "authorization_code") {
    return exchangeCode(c, prisma, config, form);
  }
  if (grantType === "refresh_token") {
    return exchangeRefresh(c, prisma, config, form);
  }
  return c.json({ error: "unsupported_grant_type" }, 400);
});

type TokenForm = Record<string, string | File>;

async function exchangeCode(
  c: Context<AppEnv>,
  prisma: PrismaClient,
  config: Config,
  form: TokenForm,
) {
  const code = String(form["code"] ?? "");
  const clientId = String(form["client_id"] ?? "");
  const redirectUri = String(form["redirect_uri"] ?? "");
  const codeVerifier = form["code_verifier"]
    ? String(form["code_verifier"])
    : undefined;

  if (!code || !clientId) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client) return c.json({ error: "invalid_client" }, 401);

  // Confidential clients must authenticate; public (none) clients rely on PKCE.
  if (client.tokenEndpointAuthMethod !== "none") {
    const secret = String(form["client_secret"] ?? "");
    if (!secret || client.clientSecretHash !== sha256(secret)) {
      return c.json({ error: "invalid_client" }, 401);
    }
  }

  const codeHash = sha256(code);
  const row = await prisma.oAuthAuthCode.findUnique({ where: { codeHash } });
  // Single-use: reject if missing, already consumed, or expired.
  if (
    !row ||
    row.consumedAt ||
    row.expiresAt < new Date() ||
    row.clientId !== clientId
  ) {
    return c.json({ error: "invalid_grant" }, 400);
  }
  // Exact redirect_uri match (must equal the one bound at /authorize).
  if (row.redirectUri !== redirectUri) {
    return c.json(
      { error: "invalid_grant", error_description: "redirect_uri mismatch" },
      400,
    );
  }
  // PKCE — required and verified here.
  if (!verifyPkceS256(codeVerifier, row.codeChallenge)) {
    return c.json(
      { error: "invalid_grant", error_description: "PKCE verification failed" },
      400,
    );
  }

  // Atomically consume the code (single-use; a race loses).
  const consumed = await prisma.oAuthAuthCode.updateMany({
    where: { codeHash, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    return c.json({ error: "invalid_grant" }, 400);
  }

  const sealedKey = pendingAgentKeys.get(codeHash);
  pendingAgentKeys.delete(codeHash);
  if (!sealedKey) {
    // Lost (relay restart between consent and exchange). The client should
    // re-authorize. Surface as invalid_grant so it restarts the flow.
    return c.json(
      {
        error: "invalid_grant",
        error_description: "authorization expired; re-authorize",
      },
      400,
    );
  }

  return c.json(
    await issueTokenPair(prisma, config, {
      clientId,
      humanId: row.humanId,
      agentId: row.agentId,
      scope: row.scope,
      resource: row.resource,
      sealedKey,
    }),
  );
}

async function exchangeRefresh(
  c: Context<AppEnv>,
  prisma: PrismaClient,
  config: Config,
  form: TokenForm,
) {
  const refreshToken = String(form["refresh_token"] ?? "");
  const clientId = String(form["client_id"] ?? "");
  if (!refreshToken || !clientId) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client) return c.json({ error: "invalid_client" }, 401);
  if (client.tokenEndpointAuthMethod !== "none") {
    const secret = String(form["client_secret"] ?? "");
    if (!secret || client.clientSecretHash !== sha256(secret)) {
      return c.json({ error: "invalid_client" }, 401);
    }
  }

  const tokenHash = sha256(refreshToken);
  const row = await prisma.oAuthToken.findUnique({ where: { tokenHash } });
  if (
    !row ||
    row.kind !== "refresh" ||
    row.revokedAt ||
    row.expiresAt < new Date() ||
    row.clientId !== clientId
  ) {
    return c.json({ error: "invalid_grant" }, 400);
  }

  // Rotate: revoke the old refresh token + its last-issued access token, then
  // mint a fresh pair (refresh-token rotation — limits replay of a leaked RT).
  await prisma.oAuthToken.update({
    where: { tokenHash },
    data: { revokedAt: new Date() },
  });
  if (row.refreshFor) {
    await prisma.oAuthToken.updateMany({
      where: { tokenHash: row.refreshFor, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return c.json(
    await issueTokenPair(prisma, config, {
      clientId,
      humanId: row.humanId,
      agentId: row.agentId,
      scope: row.scope,
      resource: row.resource,
      sealedKey: row.agentKeyEnc,
    }),
  );
}

/** Mint an access+refresh token pair mapping to the given agent. */
async function issueTokenPair(
  prisma: AppEnv["Variables"]["prisma"],
  config: AppEnv["Variables"]["config"],
  p: {
    clientId: string;
    humanId: string;
    agentId: string;
    scope: string | null;
    resource: string | null;
    sealedKey: string;
  },
) {
  const accessToken = generateOAuthToken();
  const refreshToken = generateOAuthToken();
  const accessHash = sha256(accessToken);
  const refreshHash = sha256(refreshToken);
  const now = Date.now();

  await prisma.oAuthToken.create({
    data: {
      tokenHash: accessHash,
      kind: "access",
      clientId: p.clientId,
      humanId: p.humanId,
      agentId: p.agentId,
      scope: p.scope,
      resource: p.resource,
      agentKeyEnc: p.sealedKey,
      expiresAt: new Date(now + config.MCP_OAUTH_ACCESS_TTL_SECONDS * 1000),
    },
  });
  await prisma.oAuthToken.create({
    data: {
      tokenHash: refreshHash,
      kind: "refresh",
      clientId: p.clientId,
      humanId: p.humanId,
      agentId: p.agentId,
      scope: p.scope,
      resource: p.resource,
      agentKeyEnc: p.sealedKey,
      refreshFor: accessHash,
      expiresAt: new Date(now + config.MCP_OAUTH_REFRESH_TTL_SECONDS * 1000),
    },
  });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.MCP_OAUTH_ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: p.scope ?? PANE_SCOPE,
  };
}

// ----- Revocation (RFC 7009) ----------------------------------------------

oauth.post("/revoke", async (c) => {
  const prisma = c.get("prisma");
  const form = await c.req.parseBody();
  const token = String(form["token"] ?? "");
  if (!token) {
    // RFC 7009: invalid token is still a 200 (revocation is idempotent).
    return c.body(null, 200);
  }
  const tokenHash = sha256(token);
  const row = await prisma.oAuthToken.findUnique({ where: { tokenHash } });
  if (row && !row.revokedAt) {
    // Revoke the presented token. If it's a refresh token, also revoke the
    // access token it minted; if it's an access token, leave the refresh alone
    // (RFC 7009 allows but doesn't require cascading either way — we cascade
    // refresh→access for tighter disconnect).
    await prisma.oAuthToken.update({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
    if (row.kind === "refresh" && row.refreshFor) {
      await prisma.oAuthToken.updateMany({
        where: { tokenHash: row.refreshFor, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }
  return c.body(null, 200);
});

/**
 * Verify an access token → the mapped identity, or null. Used by the MCP route
 * (and exposed for tests). Resolves token → agent + decrypted agent key so the
 * MCP request can act AS that agent.
 */
export async function verifyMcpAccessToken(
  prisma: AppEnv["Variables"]["prisma"],
  token: string,
): Promise<{
  clientId: string;
  humanId: string;
  agentId: string;
  scope: string;
  agentApiKey: string;
  expiresAt: number;
} | null> {
  const row = await prisma.oAuthToken.findUnique({
    where: { tokenHash: sha256(token) },
  });
  if (
    !row ||
    row.kind !== "access" ||
    row.revokedAt ||
    row.expiresAt < new Date()
  ) {
    return null;
  }
  // The mapped agent must still be live (not revoked / soft-deleted).
  const agent = await prisma.agent.findUnique({ where: { id: row.agentId } });
  if (!agent || agent.revokedAt || agent.deletedAt) return null;

  let agentApiKey: string;
  try {
    agentApiKey = openAgentKey(row.agentKeyEnc);
  } catch (e) {
    log.warn("oauth token agent-key decrypt failed", {
      tokenPrefix: sha256(token).slice(0, 8),
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  return {
    clientId: row.clientId,
    humanId: row.humanId,
    agentId: row.agentId,
    scope: row.scope ?? PANE_SCOPE,
    agentApiKey,
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Minimal consent page (no framework, inline styles — matches the relay's
// system-page aesthetic loosely; the relay's brand CSS isn't required here).
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function consentPage(p: {
  clientName: string;
  humanEmail: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
  resource: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${esc(p.clientName)} · pane</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1.25rem; }
  .card { border: 1px solid #8883; border-radius: 12px; padding: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  .who { color: #8889; font-size: .9rem; margin-bottom: 1rem; }
  .scope { background: #8881; border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; font-size: .95rem; }
  .row { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { flex: 1; padding: .7rem 1rem; border-radius: 8px; border: 1px solid #8884; font: inherit; cursor: pointer; }
  button.allow { background: #e8553a; border-color: #e8553a; color: #fff; font-weight: 600; }
  button.deny { background: transparent; }
  form { display: contents; }
</style>
</head>
<body>
  <div class="card">
    <h1>Allow <b>${esc(p.clientName)}</b> to access your pane account?</h1>
    <div class="who">Signed in as ${esc(p.humanEmail)}</div>
    <div class="scope">
      <b>${esc(p.clientName)}</b> will be able to create panes, send and read
      events and records, and manage templates and attachments as a pane agent
      owned by you. You can disconnect it any time from your pane settings.
    </div>
    <div class="row">
      <form method="post" action="/oauth/authorize/decision">
        <input type="hidden" name="client_id" value="${esc(p.clientId)}" />
        <input type="hidden" name="redirect_uri" value="${esc(p.redirectUri)}" />
        <input type="hidden" name="code_challenge" value="${esc(p.codeChallenge)}" />
        <input type="hidden" name="state" value="${esc(p.state)}" />
        <input type="hidden" name="scope" value="${esc(p.scope)}" />
        <input type="hidden" name="resource" value="${esc(p.resource)}" />
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        <button class="allow" type="submit" name="decision" value="allow">Allow</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

export { oauth, LOGIN_COOKIE_NAME };
