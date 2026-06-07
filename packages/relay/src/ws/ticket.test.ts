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
    const t = issueTicket(author, "pan_a");
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBe(43);
  });

  it("issue -> redeem round trip returns the bound author (emit-capable by default)", () => {
    const t = issueTicket(author, "pan_a");
    expect(redeemTicket(t, "pan_a")).toEqual({ author, canEmit: true });
  });

  it("is single-use: a second redeem fails", () => {
    const t = issueTicket(author, "pan_a");
    expect(redeemTicket(t, "pan_a")).toEqual({ author, canEmit: true });
    expect(redeemTicket(t, "pan_a")).toBeNull();
  });

  it("stamps canEmit:false on a receive-only ticket", () => {
    const t = issueTicket(author, "pan_a", { canEmit: false });
    expect(redeemTicket(t, "pan_a")).toEqual({ author, canEmit: false });
  });

  it("defaults to canEmit:true when no options are given (back-compat)", () => {
    const t = issueTicket(author, "pan_a", {});
    expect(redeemTicket(t, "pan_a")).toEqual({ author, canEmit: true });
  });

  it("rejects an unknown ticket", () => {
    expect(redeemTicket("nope", "pan_a")).toBeNull();
  });

  it("rejects a ticket redeemed against the wrong pane", () => {
    const t = issueTicket(author, "pan_a");
    expect(redeemTicket(t, "pan_b")).toBeNull();
    // A wrong-pane redeem still burns the ticket (single-use).
    expect(redeemTicket(t, "pan_a")).toBeNull();
  });

  it("rejects a ticket past its TTL", () => {
    vi.useFakeTimers();
    try {
      const t = issueTicket(author, "pan_a");
      vi.advanceTimersByTime(TICKET_TTL_MS + 1);
      expect(redeemTicket(t, "pan_a")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still redeems a ticket just inside its TTL", () => {
    vi.useFakeTimers();
    try {
      const t = issueTicket(author, "pan_a");
      vi.advanceTimersByTime(TICKET_TTL_MS - 1);
      expect(redeemTicket(t, "pan_a")).toEqual({ author, canEmit: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the agent author kind/id", () => {
    const agentAuthor: Author = { kind: "agent", id: "ag_1" };
    const t = issueTicket(agentAuthor, "pan_x");
    expect(redeemTicket(t, "pan_x")).toEqual({
      author: agentAuthor,
      canEmit: true,
    });
  });
});
