import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  generateAgentParticipantToken,
  generateHumanParticipantToken,
  hashKey,
  keyPrefix,
} from "./keys.js";

describe("keys", () => {
  it("generates a 'pane_' prefixed api key with 32 hex chars", () => {
    const k = generateApiKey();
    expect(k).toMatch(/^pane_[0-9a-f]{32}$/);
  });

  it("generates an agent participant token with the 'tok_a_' prefix (49 chars)", () => {
    const t = generateAgentParticipantToken();
    expect(t).toMatch(/^tok_a_[A-Za-z0-9_-]{43}$/);
    expect(t.length).toBe(49);
  });

  it("generates a human participant token with the 'tok_h_' prefix (49 chars)", () => {
    const t = generateHumanParticipantToken();
    expect(t).toMatch(/^tok_h_[A-Za-z0-9_-]{43}$/);
    expect(t.length).toBe(49);
  });

  it("hashKey is deterministic and returns 64 hex chars", () => {
    expect(hashKey("foo")).toBe(hashKey("foo"));
    expect(hashKey("foo")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey("foo")).not.toBe(hashKey("bar"));
  });

  it("keyPrefix for an api key returns 11 chars and is a prefix of the key", () => {
    const k = generateApiKey();
    const p = keyPrefix(k);
    expect(p.length).toBe(11);
    expect(k.startsWith(p)).toBe(true);
  });

  it("keyPrefix for a participant token returns a 12-char type-aware prefix", () => {
    const agentTok = generateAgentParticipantToken();
    const ap = keyPrefix(agentTok);
    expect(ap.length).toBe(12);
    expect(ap.startsWith("tok_a_")).toBe(true);
    expect(agentTok.startsWith(ap)).toBe(true);

    const humanTok = generateHumanParticipantToken();
    const hp = keyPrefix(humanTok);
    expect(hp.length).toBe(12);
    expect(hp.startsWith("tok_h_")).toBe(true);
    expect(humanTok.startsWith(hp)).toBe(true);
  });
});
