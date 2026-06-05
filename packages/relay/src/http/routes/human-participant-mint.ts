// Shared human-side Participant minting — the `h_${N}` allocator behind both
// the human-authed mint routes (routes/participants-human.ts: identity-link /
// public-link) and the owner-shell Share dialog's "copy link" share-link mint
// (routes/my-panes.ts). One implementation so the two surfaces can never drift
// on the (paneId, identityId) allocation / retry behaviour.

import type { PrismaClient } from "@prisma/client";

// Mint a kind="human" Participant on a pane, retrying on the
// (paneId, identityId) unique-constraint collision a concurrent mint can
// cause. The identityId is allocated monotonically from the ever-minted human
// count (matching the agent-side allocator in routes/panes.ts); two concurrent
// invites that both read the same count and pick the same `h_${N}` see P2002 on
// the loser, which loops back, re-reads the count, and picks the next index.
export async function mintHumanParticipantWithRetry(args: {
  prisma: PrismaClient;
  paneId: string;
  tokenHash: string;
  tokenPrefix: string;
  humanId?: string;
}): Promise<{ id: string; identityId: string; tokenPrefix: string }> {
  const { prisma, paneId, tokenHash, tokenPrefix, humanId } = args;
  // Cap the retry budget. Each round wins or loses one identity-id slot, so
  // the worst case is bounded by "at most N concurrent racers each running to
  // exhaustion against each other" — pegging this at 8 covers any realistic
  // owner-side burst (clicking Invite twice fast in two tabs).
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const everCount = await prisma.participant.count({
      where: { paneId, kind: "human" },
    });
    try {
      return await prisma.participant.create({
        data: {
          paneId,
          kind: "human",
          identityId: `h_${everCount}`,
          tokenHash,
          tokenPrefix,
          ...(humanId ? { humanId } : {}),
        },
        select: { id: true, identityId: true, tokenPrefix: true },
      });
    } catch (e) {
      // Narrow to (paneId, identityId) collisions; let other P2002s
      // (e.g. tokenHash) bubble — those signal a real bug. See
      // routes/panes.ts (POST /:id/participants) for the matching shape.
      const code = (e as { code?: string } | null)?.code;
      if (code !== "P2002" || attempt === MAX_ATTEMPTS - 1) throw e;
      const target = (e as { meta?: { target?: unknown } } | null)?.meta
        ?.target;
      const targetStr = Array.isArray(target)
        ? target.join(",")
        : String(target ?? "");
      const message = (e as { message?: string } | null)?.message ?? "";
      const isIdentityCollision =
        targetStr.includes("identity_id") ||
        targetStr.includes("participants_session_id_identity_id_key") ||
        message.includes("identity_id");
      if (!isIdentityCollision) throw e;
    }
  }
  throw new Error("could not allocate participant identity-id after retries");
}

/**
 * Build the `/s/<token>` share URL a human distributes. Falls back to a path
 * if PUBLIC_URL is not absolute — the caller can always combine with its base.
 */
export function buildParticipantUrl(args: {
  publicUrl: string;
  token: string;
}): string {
  const base = args.publicUrl.replace(/\/$/, "");
  return `${base}/s/${args.token}`;
}
