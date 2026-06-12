// OAuth 2.1 primitives for the remote-MCP authorization server.
//
// This module is the security core of the remote MCP connector. It owns:
//   - token / code / client-secret generation + hashing (sha256, never store
//     the raw value — same discipline as Agent keys and Participant tokens)
//   - PKCE S256 verification
//   - the per-token agent-API-key envelope (AES-256-GCM via crypto.ts) so a
//     verified access token can act AS its mapped agent against the relay's
//     own API without re-deriving the key
//   - provisioning (or reusing) the per-human MCP Agent the tokens map to
//
// The HTTP routes (routes/oauth.ts) and the OAuthServerProvider
// (oauth-provider.ts) call into here; this file does no HTTP and no Hono.

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Agent, PrismaClient } from "@prisma/client";
import { encryptSecret, decryptSecret, getMasterKey } from "../crypto.js";
import { generateApiKey, hashKey, keyPrefix } from "../keys.js";

/** sha256 hex of a token/code/secret — what we persist, never the raw value. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Opaque access/refresh token. `pmt_` = pane MCP token (self-identifying). */
export function generateOAuthToken(): string {
  return "pmt_" + randomBytes(32).toString("base64url");
}

/** Single-use authorization code. `pmc_` = pane MCP code. */
export function generateAuthCode(): string {
  return "pmc_" + randomBytes(32).toString("base64url");
}

/** Public client_id minted by Dynamic Client Registration. */
export function generateClientId(): string {
  return "pmcli_" + randomBytes(16).toString("hex");
}

/** Optional client_secret for confidential clients (Claude is public/PKCE). */
export function generateClientSecret(): string {
  return "pmcs_" + randomBytes(32).toString("base64url");
}

/** Server-side pending-authorization id (the consent form's hidden anchor). */
export function generatePendingAuthId(): string {
  return "pma_" + randomBytes(32).toString("base64url");
}

// ----- Consent CSRF token (signed, single-use, session-bound) -------------
//
// The consent decision is a cookie-authenticated, state-changing POST (it mints
// an authorization code). SameSite=Lax alone is insufficient (csrf.ts §6-9), so
// the consent form embeds an anti-CSRF token that the decision handler verifies.
//
// The token is `<nonce>.<hmac>` where hmac = HMAC-SHA256(masterKey,
// loginSessionHash + ":" + pendingAuthId + ":" + nonce). It is therefore bound
// to BOTH the specific login session that rendered the form AND the specific
// pending authorization — a token minted for one human's session can't be
// replayed against another's, and a token for one authorization can't be reused
// for another. Single-use is enforced separately by deleting the pending-auth
// record on first use. `loginSessionHash` is sha256(login cookie) (the same
// value persisted as Login.cookieHash) — never the raw cookie.

/** Mint a consent CSRF token bound to (login session, pending authorization). */
export function generateConsentCsrfToken(
  loginSessionHash: string,
  pendingAuthId: string,
): string {
  const nonce = randomBytes(16).toString("base64url");
  const mac = createHmac("sha256", getMasterKey())
    .update(`${loginSessionHash}:${pendingAuthId}:${nonce}`)
    .digest("base64url");
  return `${nonce}.${mac}`;
}

/**
 * Verify a consent CSRF token against the presenting session + pending auth.
 * Constant-time on the MAC compare; returns false on any structural problem.
 */
export function verifyConsentCsrfToken(
  token: string | undefined,
  loginSessionHash: string,
  pendingAuthId: string,
): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const nonce = token.slice(0, dot);
  const presented = token.slice(dot + 1);
  const expected = createHmac("sha256", getMasterKey())
    .update(`${loginSessionHash}:${pendingAuthId}:${nonce}`)
    .digest("base64url");
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a PKCE code_verifier against a stored S256 challenge. PKCE is
 * REQUIRED for this server: a missing/short verifier, or a mismatch, returns
 * false and the caller rejects the exchange (invalid_grant).
 *
 * S256: BASE64URL(SHA256(ASCII(code_verifier))) === code_challenge.
 * The verifier must be 43..128 chars per RFC 7636.
 */
export function verifyPkceS256(
  codeVerifier: string | undefined,
  storedChallenge: string,
): boolean {
  if (!codeVerifier) return false;
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const computed = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  // Constant-time compare to avoid leaking the challenge through timing.
  const a = Buffer.from(computed);
  const b = Buffer.from(storedChallenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Exact-match a presented redirect_uri against a client's registered set.
 * No normalisation, no prefix/suffix matching — open-redirect defence is an
 * exact string compare (RFC 6749 §3.1.2.3 / OAuth 2.1).
 */
export function redirectUriAllowed(
  registered: unknown,
  presented: string,
): boolean {
  if (!Array.isArray(registered)) return false;
  return registered.some((u) => typeof u === "string" && u === presented);
}

/**
 * Provision (or reuse) the Agent a human's MCP tokens map to. One MCP agent
 * per human: a stable name lets repeat authorizations reuse the same agent and
 * its accumulated panes/templates, exactly like a CLI agent the human claimed.
 *
 * Returns the agent plus its PLAINTEXT api key.
 *
 * KEY STABILITY (do NOT rotate on reuse): an earlier design re-minted the agent
 * key on every authorization, which overwrote the agent's `keyHash` and so
 * silently invalidated every previously-issued OAuth token (each token carries
 * its own sealed copy of the key it was issued with — that copy decrypts to the
 * OLD key, whose hash no longer matches the agent row, so the relay's /v1 API
 * rejects it). Two overlapping authorize flows, or a re-authorize while a token
 * is live, would break the live token. To keep the human's MCP agent key
 * STABLE across re-authorizations, the agent stores its key sealed at-rest
 * (`mcpKeyEnc`, AES-256-GCM via crypto.ts — same envelope as the token copy).
 * On first provision we generate, seal, and store it; on reuse we DECRYPT the
 * stored copy and return the SAME plaintext key, leaving `keyHash` untouched so
 * every outstanding token keeps authenticating.
 */
export const MCP_AGENT_NAME_PREFIX = "claude-mcp";

export async function provisionMcpAgent(
  prisma: PrismaClient,
  humanId: string,
): Promise<{ agent: Agent; apiKey: string }> {
  // Reuse the human's existing MCP agent if one exists (and isn't deleted).
  const existing = await prisma.agent.findFirst({
    where: {
      ownerHumanId: humanId,
      name: { startsWith: MCP_AGENT_NAME_PREFIX },
      deletedAt: null,
      revokedAt: null,
    },
    orderBy: { createdAt: "asc" },
  });

  if (existing) {
    // Recover the STABLE key from the at-rest sealed copy — no rotation, so
    // tokens issued by prior authorizations keep working.
    if (existing.mcpKeyEnc) {
      const apiKey = decryptSecret(existing.mcpKeyEnc);
      const agent = await prisma.agent.update({
        where: { id: existing.id },
        data: { lastUsedAt: new Date() },
      });
      return { agent, apiKey };
    }
    // Legacy MCP agent created before key-at-rest storage (no sealed copy):
    // mint + persist a key once so future reuse is stable. Any tokens issued
    // before this point already had to re-authorize (the old design rotated),
    // so adopting a fresh stable key here is safe and one-time.
    const apiKey = generateApiKey();
    const agent = await prisma.agent.update({
      where: { id: existing.id },
      data: {
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
        mcpKeyEnc: encryptSecret(apiKey),
        lastUsedAt: new Date(),
      },
    });
    return { agent, apiKey };
  }

  const apiKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      name: MCP_AGENT_NAME_PREFIX,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      mcpKeyEnc: encryptSecret(apiKey),
      ownerHumanId: humanId,
      claimedAt: new Date(),
    },
  });
  return { agent, apiKey };
}

/** Encrypt an agent API key for storage on an OAuth token row. */
export function sealAgentKey(apiKey: string): string {
  return encryptSecret(apiKey);
}

/** Decrypt an agent API key sealed by sealAgentKey. */
export function openAgentKey(sealed: string): string {
  return decryptSecret(sealed);
}
