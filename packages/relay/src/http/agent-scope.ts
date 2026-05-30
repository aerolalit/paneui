// Cross-agent same-human access scope (#283).
//
// Once two agents are claimed to the same human, they form a fungible
// fleet over the human's resources: any of them can read/write any
// surface or template owned by any of the human's claimed agents.
// Unclaimed agents stay strictly self-scoped.

import type { Agent, PrismaClient } from "@prisma/client";

/**
 * Set of agent IDs the caller may act on.
 *
 * - Unclaimed agent (`ownerHumanId === null`): just itself.
 * - Claimed agent: every agent claimed to the same human (this includes
 *   the caller, since the caller is one of them).
 *
 * Callers use this as `where: { agentId: { in: scope } }` for list
 * queries, and as `scope.has(resource.agentId)` for point-lookup
 * authorization.
 */
export async function agentScope(
  prisma: PrismaClient,
  agent: Pick<Agent, "id" | "ownerHumanId">,
): Promise<Set<string>> {
  if (!agent.ownerHumanId) return new Set([agent.id]);
  const siblings = await prisma.agent.findMany({
    where: { ownerHumanId: agent.ownerHumanId },
    select: { id: true },
  });
  return new Set(siblings.map((s) => s.id));
}
