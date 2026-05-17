// Startup reconciliation of orphaned `system.participant.joined` events.
//
// A `system.participant.joined` row is written when a WebSocket connects; the
// matching `system.participant.left` is written fire-and-forget from the `ws`
// `close` handler. If the relay crashes/restarts (or the DB hiccups) between a
// connect and the corresponding close, the `left` row is never written and the
// log keeps an orphan `joined` — replayed forever as a participant who never
// leaves.
//
// At process startup there are, by definition, zero live WebSocket connections:
// the in-memory presence registry is empty. So any `joined` on a still-open
// session that has no matching `left` is provably stale. We emit one synthetic
// `system.participant.left` per surplus `joined` to close the log out.
//
// Pairing is per (sessionId, author): each session can have one agent author
// plus N human authors, and each may connect/disconnect repeatedly, so we
// compare counts rather than assuming a single join.

import prisma from "../db.js";
import { log } from "../log.js";

interface AuthorRef {
  kind: string;
  id: string;
}

function authorOf(data: unknown): AuthorRef | null {
  if (!data || typeof data !== "object") return null;
  const a = (data as { author?: unknown }).author;
  if (!a || typeof a !== "object") return null;
  const { kind, id } = a as { kind?: unknown; id?: unknown };
  if (typeof kind !== "string" || typeof id !== "string") return null;
  return { kind, id };
}

// Emit a synthetic `system.participant.left` for every `joined` that has no
// matching `left`, across all still-open sessions. Returns the number of
// synthetic events written. Best-effort: a failure is logged, not thrown, so a
// reconciliation hiccup never blocks relay startup.
export async function reconcileOrphanedParticipants(): Promise<number> {
  let written = 0;
  try {
    const openSessions = await prisma.session.findMany({
      where: { status: "open" },
      select: { id: true },
    });

    for (const { id: sessionId } of openSessions) {
      const events = await prisma.event.findMany({
        where: {
          sessionId,
          authorKind: "system",
          type: {
            in: ["system.participant.joined", "system.participant.left"],
          },
        },
        orderBy: { id: "asc" },
        select: { type: true, data: true },
      });

      // Net join count per author key ("kind:id"). Each `joined` is +1, each
      // `left` is -1; a positive remainder is an orphan that needs a `left`.
      const balance = new Map<string, { author: AuthorRef; net: number }>();
      for (const ev of events) {
        const author = authorOf(ev.data);
        if (!author) continue;
        const key = `${author.kind}:${author.id}`;
        const entry = balance.get(key) ?? { author, net: 0 };
        entry.net += ev.type === "system.participant.joined" ? 1 : -1;
        balance.set(key, entry);
      }

      for (const { author, net } of balance.values()) {
        for (let i = 0; i < net; i++) {
          await prisma.event.create({
            data: {
              sessionId,
              authorKind: "system",
              authorId: "system",
              type: "system.participant.left",
              data: { author } as object,
            },
          });
          written++;
        }
      }
    }

    if (written > 0) {
      log.info("reconciled orphaned participant.joined events", {
        syntheticLeftEvents: written,
      });
    }
  } catch (err) {
    log.warn("participant reconciliation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return written;
}
