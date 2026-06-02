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

export interface ResolveScopeOpts {
  /**
   * Restrict the scope to a single pane id. Mirrors the security model:
   * the pane is only included if it would already be visible to the caller
   * under the default scope. Missing / not-owned panes return an empty
   * paneIds (the engine then surfaces a clean not-found to the caller).
   */
  paneId?: string | null;
}

// Look up the panes this caller is allowed to query. The returned ids
// drive the WHERE clause on every materialized view in the DuckDB session.
//
// `prisma` is the relay's normal connection; the lookup is read-only and
// runs against the live database.
export async function resolveScope(
  prisma: PrismaClient,
  caller: ScopedCaller,
  opts: ResolveScopeOpts = {},
): Promise<ResolvedScope> {
  const baseWhere = caller.ownerHumanId
    ? { ownerHumanId: caller.ownerHumanId, deletedAt: null }
    : { agentId: caller.agentId, ownerHumanId: null, deletedAt: null };
  const kind: "human" | "agent" = caller.ownerHumanId ? "human" : "agent";

  // --pane <id> narrows the scope to one row, but the row must still pass
  // the default predicate — caller can't peek at another human's pane by
  // guessing the id.
  if (opts.paneId !== undefined && opts.paneId !== null) {
    const row = await prisma.pane.findFirst({
      where: { ...baseWhere, id: opts.paneId },
      select: { id: true },
    });
    return { kind, paneIds: row ? [row.id] : [] };
  }

  const rows = await prisma.pane.findMany({
    where: baseWhere,
    select: { id: true },
    take: PANE_FETCH_LIMIT,
  });
  return { kind, paneIds: rows.map((r) => r.id) };
}
