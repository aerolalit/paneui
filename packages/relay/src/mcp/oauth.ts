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

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Agent, PrismaClient } from "@prisma/client";
import { encryptSecret, decryptSecret } from "../crypto.js";
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
 * Returns the agent plus its PLAINTEXT api key. The key is freshly generated
 * (we never stored the old one in plaintext); on reuse we ROTATE the key —
 * the previous tokens carried their own encrypted copy of the old key, and the
 * fresh key is encrypted into the new token. The agent row stores only the
 * hash, as for any agent.
 */
export const MCP_AGENT_NAME_PREFIX = "claude-mcp";

export async function provisionMcpAgent(
  prisma: PrismaClient,
  humanId: string,
): Promise<{ agent: Agent; apiKey: string }> {
  const apiKey = generateApiKey();
  const keyHash = hashKey(apiKey);
  const prefix = keyPrefix(apiKey);

  // Reuse the human's existing MCP agent if one exists (and isn't deleted),
  // rotating its key; otherwise create a fresh claimed agent owned by them.
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
    const agent = await prisma.agent.update({
      where: { id: existing.id },
      data: { keyHash, keyPrefix: prefix, lastUsedAt: new Date() },
    });
    return { agent, apiKey };
  }

  const agent = await prisma.agent.create({
    data: {
      name: MCP_AGENT_NAME_PREFIX,
      keyHash,
      keyPrefix: prefix,
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
