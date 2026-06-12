// Unit tests for the OAuth crypto primitives — PKCE S256 verification,
// redirect_uri exact matching, and the agent-key seal/open round trip. No DB,
// no HTTP; the route-level behaviour is covered by oauth.e2e.test.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthCode,
  generateClientId,
  generateConsentCsrfToken,
  generateOAuthToken,
  generatePendingAuthId,
  openAgentKey,
  redirectUriAllowed,
  sealAgentKey,
  sha256,
  verifyConsentCsrfToken,
  verifyPkceS256,
} from "./oauth.js";
import { _resetKeyCacheForTests } from "../crypto.js";

beforeAll(() => {
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  _resetKeyCacheForTests();
});

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url"); // 64 chars, in range
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("verifyPkceS256", () => {
  it("accepts a matching verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("rejects a non-matching verifier", () => {
    const { challenge } = pkcePair();
    const other = randomBytes(48).toString("base64url");
    expect(verifyPkceS256(other, challenge)).toBe(false);
  });

  it("rejects a missing verifier (PKCE required)", () => {
    const { challenge } = pkcePair();
    expect(verifyPkceS256(undefined, challenge)).toBe(false);
  });

  it("rejects a too-short verifier (< 43 chars)", () => {
    const verifier = "short";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkceS256(verifier, challenge)).toBe(false);
  });
});

describe("redirectUriAllowed", () => {
  const registered = [
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost:33418/callback",
  ];

  it("accepts an exact registered match", () => {
    expect(
      redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback"),
    ).toBe(true);
  });

  it("rejects a trailing-slash variant (exact match only)", () => {
    expect(
      redirectUriAllowed(
        registered,
        "https://claude.ai/api/mcp/auth_callback/",
      ),
    ).toBe(false);
  });

  it("rejects an unregistered uri (open-redirect defence)", () => {
    expect(redirectUriAllowed(registered, "https://evil.test/x")).toBe(false);
  });

  it("rejects when registered is not an array", () => {
    expect(redirectUriAllowed(null, "https://claude.ai")).toBe(false);
  });
});

describe("token generation + hashing", () => {
  it("mints self-identifying, unique tokens", () => {
    expect(generateOAuthToken()).toMatch(/^pmt_/);
    expect(generateAuthCode()).toMatch(/^pmc_/);
    expect(generateClientId()).toMatch(/^pmcli_/);
    expect(generateOAuthToken()).not.toBe(generateOAuthToken());
  });

  it("sha256 is stable + hex", () => {
    const h = sha256("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256("hello")).toBe(h);
  });
});

describe("agent-key seal/open", () => {
  it("round-trips the plaintext key", () => {
    const key = "pane_" + randomBytes(16).toString("hex");
    const sealed = sealAgentKey(key);
    expect(sealed).not.toContain(key);
    expect(openAgentKey(sealed)).toBe(key);
  });
});

describe("consent CSRF token (#1)", () => {
  const session = sha256("login-cookie-a");
  const pendingId = generatePendingAuthId();

  it("verifies a token bound to (session, pending)", () => {
    const tok = generateConsentCsrfToken(session, pendingId);
    expect(verifyConsentCsrfToken(tok, session, pendingId)).toBe(true);
  });

  it("rejects a token verified against a different session", () => {
    const tok = generateConsentCsrfToken(session, pendingId);
    expect(
      verifyConsentCsrfToken(tok, sha256("other-session"), pendingId),
    ).toBe(false);
  });

  it("rejects a token verified against a different pending id", () => {
    const tok = generateConsentCsrfToken(session, pendingId);
    expect(verifyConsentCsrfToken(tok, session, generatePendingAuthId())).toBe(
      false,
    );
  });

  it("rejects a missing or malformed token", () => {
    expect(verifyConsentCsrfToken(undefined, session, pendingId)).toBe(false);
    expect(verifyConsentCsrfToken("", session, pendingId)).toBe(false);
    expect(verifyConsentCsrfToken("no-dot", session, pendingId)).toBe(false);
    expect(verifyConsentCsrfToken(".onlymac", session, pendingId)).toBe(false);
  });

  it("rejects a token whose MAC was tampered", () => {
    const tok = generateConsentCsrfToken(session, pendingId);
    const [nonce] = tok.split(".");
    expect(
      verifyConsentCsrfToken(`${nonce}.deadbeef`, session, pendingId),
    ).toBe(false);
  });

  it("mints unique pending ids with the pma_ prefix", () => {
    expect(generatePendingAuthId()).toMatch(/^pma_/);
    expect(generatePendingAuthId()).not.toBe(generatePendingAuthId());
  });
});
