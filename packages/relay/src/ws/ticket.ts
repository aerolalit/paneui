// Short-lived, single-use WebSocket upgrade tickets.
//
// Browsers cannot set an Authorization header on `new WebSocket()`, so the
// only browser-viable way to authenticate a WS upgrade is a query parameter.
// Putting the long-lived participant/agent token there leaks it into any
// reverse-proxy / load-balancer access log that records the URL BEFORE the
// relay sees it (the relay can only redact its own logs).
//
// A ticket fixes that: the client first calls an authenticated HTTP endpoint
// (`POST /v1/panes/:id/ws-ticket`) to mint a ticket, then puts the *ticket*
// in the WS URL. A ticket leaking into a proxy log is near-worthless — it has
// a 30s TTL, is single-use, and is bound to one (identity, pane) pair.
//
// STORAGE: a module-level Map. Tickets are ephemeral (30s) and low-volume, so
// an in-process map is the correct, simplest backend — no DB row, no Redis.
//
// CAVEAT — per-process: the map is per-replica. A ticket minted on replica A
// cannot be redeemed on replica B. This is acceptable today because the relay
// runs single-replica. When multi-replica lands (see issue #42 / #78) the
// natural fix is to move ticket storage to Redis; this module is deliberately
// small and self-contained so swapping its backend stays localised.

import { randomBytes } from "node:crypto";
import type { Author } from "../types.js";

// Ticket lifetime. Issue #8 specifies 30 seconds: long enough for a client to
// mint a ticket and immediately open the WebSocket, short enough that a leaked
// ticket is worthless almost immediately.
export const TICKET_TTL_MS = 30_000;

interface TicketEntry {
  author: Author;
  paneId: string;
  expiresAt: number;
}

const tickets = new Map<string, TicketEntry>();

// Drop every expired entry so the map cannot grow unbounded. Mirrors the
// opportunistic sweep style of rate-limit.ts.
function prune(now: number): void {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
}

/**
 * Mint a ticket bound to `author` and `paneId`. Returns the opaque ticket
 * string the caller hands back to the client. The ticket is valid for
 * `TICKET_TTL_MS` and can be redeemed exactly once.
 */
export function issueTicket(author: Author, paneId: string): string {
  const now = Date.now();
  // Opportunistic sweep on the mint path keeps the map bounded without a timer.
  prune(now);
  // Same entropy as participant tokens (randomBytes(32)).
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, {
    author,
    paneId,
    expiresAt: now + TICKET_TTL_MS,
  });
  return ticket;
}

/**
 * Redeem a ticket on the WS upgrade. Returns the bound `Author` and DELETES
 * the entry (single-use) when the ticket exists, is unexpired, and its bound
 * pane matches `paneId`. Returns `null` for an unknown, expired,
 * wrong-pane, or already-redeemed ticket.
 */
export function redeemTicket(ticket: string, paneId: string): Author | null {
  const now = Date.now();
  // Prune-on-access in addition to the mint-path sweep.
  prune(now);
  const entry = tickets.get(ticket);
  if (!entry) return null;
  // Delete first: a ticket is single-use, so even a wrong-pane redeem
  // attempt burns it (it was a valid ticket; consume it).
  tickets.delete(ticket);
  if (entry.expiresAt <= now) return null;
  if (entry.paneId !== paneId) return null;
  return entry.author;
}

// Test-only: clear all tickets so unit tests start from a clean map.
export function _clearTicketsForTest(): void {
  tickets.clear();
}
