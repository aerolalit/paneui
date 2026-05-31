import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  issueTicket,
  redeemTicket,
  TICKET_TTL_MS,
  _clearTicketsForTest,
} from "./ticket.js";
import type { Author } from "../types.js";

const author: Author = { kind: "human", id: "h_0" };

describe("ws ticket store", () => {
  beforeEach(() => {
    _clearTicketsForTest();
  });

  it("issues a high-entropy base64url ticket", () => {
    const t = issueTicket(author, "sur_a");
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBe(43);
  });

  it("issue -> redeem round trip returns the bound author", () => {
    const t = issueTicket(author, "sur_a");
    expect(redeemTicket(t, "sur_a")).toEqual(author);
  });

  it("is single-use: a second redeem fails", () => {
    const t = issueTicket(author, "sur_a");
    expect(redeemTicket(t, "sur_a")).toEqual(author);
    expect(redeemTicket(t, "sur_a")).toBeNull();
  });

  it("rejects an unknown ticket", () => {
    expect(redeemTicket("nope", "sur_a")).toBeNull();
  });

  it("rejects a ticket redeemed against the wrong surface", () => {
    const t = issueTicket(author, "sur_a");
    expect(redeemTicket(t, "sur_b")).toBeNull();
    // A wrong-surface redeem still burns the ticket (single-use).
    expect(redeemTicket(t, "sur_a")).toBeNull();
  });

  it("rejects a ticket past its TTL", () => {
    vi.useFakeTimers();
    try {
      const t = issueTicket(author, "sur_a");
      vi.advanceTimersByTime(TICKET_TTL_MS + 1);
      expect(redeemTicket(t, "sur_a")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still redeems a ticket just inside its TTL", () => {
    vi.useFakeTimers();
    try {
      const t = issueTicket(author, "sur_a");
      vi.advanceTimersByTime(TICKET_TTL_MS - 1);
      expect(redeemTicket(t, "sur_a")).toEqual(author);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the agent author kind/id", () => {
    const agentAuthor: Author = { kind: "agent", id: "ag_1" };
    const t = issueTicket(agentAuthor, "sur_x");
    expect(redeemTicket(t, "sur_x")).toEqual(agentAuthor);
  });
});
