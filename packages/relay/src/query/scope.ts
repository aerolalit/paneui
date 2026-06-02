// Resolve a calling agent to the set of panes they're allowed to see.
//
// Mirrors the predicate the /my-panes route already uses
// (system-pages.ts ~L543 + the ownerHumanId-vs-agentId branch in panes.ts):
//
//   - claimed agent  (agent.ownerHumanId set)  → all panes where
//                                                pane.ownerHumanId === agent.ownerHumanId
//                                                (cross-agent same-human, #283)
//   - standalone agent (no ownerHumanId)       → all panes where
//                                                pane.agentId === agent.id
//
// Soft-deleted panes are excluded by default.

import type { PrismaClient } from "@prisma/client";

export interface ScopedCaller {
  agentId: string;
  ownerHumanId: string | null;
}

export interface ResolvedScope {
  // The literal predicate used: lets logs/errors report "scoped to your
  // human" vs "scoped to this standalone agent's panes" without revealing
  // the human id.
  kind: "human" | "agent";
  // The pane ids visible to this caller. Empty array = no panes yet.
  paneIds: string[];
}

const PANE_FETCH_LIMIT = 5_000;

// Look up the panes this caller is allowed to query. The returned ids
// drive the WHERE clause on every materialized view in the DuckDB session.
//
// `prisma` is the relay's normal connection; the lookup is read-only and
// runs against the live database.
export async function resolveScope(
  prisma: PrismaClient,
  caller: ScopedCaller,
): Promise<ResolvedScope> {
  if (caller.ownerHumanId) {
    const rows = await prisma.pane.findMany({
      where: {
        ownerHumanId: caller.ownerHumanId,
        deletedAt: null,
      },
      select: { id: true },
      take: PANE_FETCH_LIMIT,
    });
    return { kind: "human", paneIds: rows.map((r) => r.id) };
  }

  const rows = await prisma.pane.findMany({
    where: {
      agentId: caller.agentId,
      ownerHumanId: null,
      deletedAt: null,
    },
    select: { id: true },
    take: PANE_FETCH_LIMIT,
  });
  return { kind: "agent", paneIds: rows.map((r) => r.id) };
}
