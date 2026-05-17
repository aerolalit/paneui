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
    const t = issueTicket(author, "ses_a");
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBe(43);
  });

  it("issue -> redeem round trip returns the bound author", () => {
    const t = issueTicket(author, "ses_a");
    expect(redeemTicket(t, "ses_a")).toEqual(author);
  });

  it("is single-use: a second redeem fails", () => {
    const t = issueTicket(author, "ses_a");
    expect(redeemTicket(t, "ses_a")).toEqual(author);
    expect(redeemTicket(t, "ses_a")).toBeNull();
  });

  it("rejects an unknown ticket", () => {
    expect(redeemTicket("nope", "ses_a")).toBeNull();
  });

  it("rejects a ticket redeemed against the wrong session", () => {
    const t = issueTicket(author, "ses_a");
    expect(redeemTicket(t, "ses_b")).toBeNull();
    // A wrong-session redeem still burns the ticket (single-use).
    expect(redeemTicket(t, "ses_a")).toBeNull();
  });

  it("rejects a ticket past its TTL", () => {
    vi.useFakeTimers();
    try {
      const t = issueTicket(author, "ses_a");
      vi.advanceTimersByTime(TICKET_TTL_MS + 1);
      expect(redeemTicket(t, "ses_a")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still redeems a ticket just inside its TTL", () => {
    vi.useFakeTimers();
    try {
      const t = issueTicket(author, "ses_a");
      vi.advanceTimersByTime(TICKET_TTL_MS - 1);
      expect(redeemTicket(t, "ses_a")).toEqual(author);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the agent author kind/id", () => {
    const agentAuthor: Author = { kind: "agent", id: "ag_1" };
    const t = issueTicket(agentAuthor, "ses_x");
    expect(redeemTicket(t, "ses_x")).toEqual(agentAuthor);
  });
});
