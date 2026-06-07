// Shared lazy-mint for a human's identity-bound, cookie-only Participant on a
// pane. Used by:
//   - owner-shell (/panes/:id)  — the pane owner's own session participant.
//   - pane-access (/p/:paneId)  — a `participant`-role grantee's session
//                                 participant (so they can emit page events).
//
// The raw token is generated only because Participant.tokenHash is `@unique`
// and required; it is NEVER returned and never persisted in any form besides
// the SHA-256 hash. The row is therefore reachable ONLY through cookie-authed
// pane-id routes — never via /s/<token>.
//
// Concurrency: `findFirst` + `create` is a check-then-act race (two tabs, a
// mobile/desktop overlap). The `(paneId, identityId)` unique constraint
// serialises the write — the loser gets P2002, we re-`findFirst` and return
// the winner's row. The identityId is the dedup key, so each (pane, role-slot)
// resolves to exactly one Participant row.

import type { PrismaClient } from "@prisma/client";
import {
  generateHumanParticipantToken,
  hashKey,
  keyPrefix,
} from "../../keys.js";

// Identity-id reserved for the pane owner's session-mode participant.
export const OWNER_IDENTITY_ID = "h_owner";

// Identity-id reserved for ANONYMOUS visitors who emit on a PUBLIC pane. A
// public pane is "view + participate" for everyone, so an anonymous (no login,
// no grant) visitor can submit page events — but an event row needs an author.
// Rather than mint a fresh participant per anonymous visitor (unbounded rows,
// no useful identity), all anonymous public emits share ONE per-pane "guest"
// participant under this slot. An admin reading the audit log sees a single
// `h_public` author for every anonymous public contribution, distinct from the
// owner / invited-participant / share-link namespaces. Mirrors how
// OWNER_IDENTITY_ID reserves the owner slot.
export const PUBLIC_IDENTITY_ID = "h_public";

// Stable, deterministic identity-id for a grantee's session participant. One
// row per (pane, human) granted `participant` role; distinct from the
// owner slot and from the `h_${N}` namespace the share-link mints use, so an
// admin reading the audit log can tell "owner", "invited participant", and
// "share-link" apart at a glance.
export function granteeIdentityId(humanId: string): string {
  return `h_grant_${humanId}`;
}

export async function getOrCreateIdentityParticipant(
  prisma: PrismaClient,
  paneId: string,
  humanId: string,
  identityId: string,
): Promise<{ identityId: string; id: string }> {
  const existing = await prisma.participant.findFirst({
    where: {
      paneId,
      identityId,
      humanId,
      kind: "human",
      revokedAt: null,
    },
    select: { id: true, identityId: true },
  });
  if (existing) return existing;

  const tok = generateHumanParticipantToken();
  try {
    const created = await prisma.participant.create({
      data: {
        paneId,
        kind: "human",
        identityId,
        tokenHash: hashKey(tok),
        tokenPrefix: keyPrefix(tok),
        humanId,
      },
      select: { id: true, identityId: true },
    });
    return created;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== "P2002") throw e;
    const target = (e as { meta?: { target?: unknown } } | null)?.meta?.target;
    const targetStr = Array.isArray(target)
      ? target.join(",")
      : String(target ?? "");
    const message = (e as { message?: string } | null)?.message ?? "";
    const isIdentityCollision =
      targetStr.includes("identity_id") ||
      targetStr.includes("participants_session_id_identity_id_key") ||
      message.includes("identity_id");
    if (!isIdentityCollision) throw e;

    const winner = await prisma.participant.findFirst({
      where: {
        paneId,
        identityId,
        humanId,
        kind: "human",
        revokedAt: null,
      },
      select: { id: true, identityId: true },
    });
    if (!winner) throw e;
    return winner;
  }
}

// Lazy-mint the single shared "public guest" participant for a pane (the
// PUBLIC_IDENTITY_ID slot, humanId = null). Used by /p/:paneId/ws-ticket when
// an ANONYMOUS visitor of a `public` pane is handed an emit-capable ticket.
// Same concurrency discipline as getOrCreateIdentityParticipant: the
// (paneId, identityId) unique constraint serialises the create; the P2002
// loser re-reads the winner. Kept separate because the human-bound helper
// filters on humanId in its where-clause, which a null-humanId guest must not.
export async function getOrCreatePublicGuestParticipant(
  prisma: PrismaClient,
  paneId: string,
): Promise<{ identityId: string; id: string }> {
  const existing = await prisma.participant.findFirst({
    where: {
      paneId,
      identityId: PUBLIC_IDENTITY_ID,
      humanId: null,
      kind: "human",
      revokedAt: null,
    },
    select: { id: true, identityId: true },
  });
  if (existing) return existing;

  const tok = generateHumanParticipantToken();
  try {
    const created = await prisma.participant.create({
      data: {
        paneId,
        kind: "human",
        identityId: PUBLIC_IDENTITY_ID,
        tokenHash: hashKey(tok),
        tokenPrefix: keyPrefix(tok),
        // No bound human — this is the shared anonymous guest slot.
      },
      select: { id: true, identityId: true },
    });
    return created;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== "P2002") throw e;
    const target = (e as { meta?: { target?: unknown } } | null)?.meta?.target;
    const targetStr = Array.isArray(target)
      ? target.join(",")
      : String(target ?? "");
    const message = (e as { message?: string } | null)?.message ?? "";
    const isIdentityCollision =
      targetStr.includes("identity_id") ||
      targetStr.includes("participants_session_id_identity_id_key") ||
      message.includes("identity_id");
    if (!isIdentityCollision) throw e;

    const winner = await prisma.participant.findFirst({
      where: {
        paneId,
        identityId: PUBLIC_IDENTITY_ID,
        humanId: null,
        kind: "human",
        revokedAt: null,
      },
      select: { id: true, identityId: true },
    });
    if (!winner) throw e;
    return winner;
  }
}
