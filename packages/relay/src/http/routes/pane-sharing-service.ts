// Shared pane-sharing logic — the single source of truth for the grant +
// visibility operations behind BOTH the agent-authed surface
// (routes/pane-sharing.ts, driven by the CLI) and the human-authed surface
// (routes/my-panes.ts, driven by the owner-shell Share dialog).
//
// The two surfaces differ ONLY in how they authorize and resolve the pane:
//   - agent  → requireAgent + assertPaneInScope (pane in the agent's scope)
//   - human  → requireHuman + ownerHumanId === human.id (404 no-oracle)
// Once a pane is resolved, the DB operations and the zod validation are
// identical, so they live here and neither route duplicates #436's logic.

import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { normalizeEmail } from "../../auth/magic-link.js";

// ----- validation (shared by both surfaces) -----

export const visibilityBody = z.object({
  is_public: z.boolean(),
});

export const createGrantBody = z.object({
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().email().max(320),
  ),
  role: z.enum(["participant", "viewer"]).optional(),
});

// ----- serialised grant shape (one wire format for both surfaces) -----

export interface GrantDTO {
  id: string;
  human_id: string | null;
  invite_email: string | null;
  role: string;
  accepted_at: string | null;
}

const grantSelect = {
  id: true,
  humanId: true,
  inviteEmail: true,
  role: true,
  acceptedAt: true,
} as const;

function toGrantDTO(g: {
  id: string;
  humanId: string | null;
  inviteEmail: string | null;
  role: string;
  acceptedAt: Date | null;
}): GrantDTO {
  return {
    id: g.id,
    human_id: g.humanId,
    invite_email: g.inviteEmail,
    role: g.role,
    accepted_at: g.acceptedAt ? g.acceptedAt.toISOString() : null,
  };
}

// ----- operations (operate on an ALREADY-AUTHORIZED pane) -----

/** Flip a pane's public visibility. The caller has already verified access. */
export async function setVisibility(
  prisma: PrismaClient,
  paneId: string,
  isPublic: boolean,
): Promise<void> {
  await prisma.pane.update({
    where: { id: paneId },
    data: { isPublic },
  });
}

/** List every grant on a pane plus its current visibility, oldest first. */
export async function listGrantsAndVisibility(
  prisma: PrismaClient,
  paneId: string,
): Promise<{ isPublic: boolean; grants: GrantDTO[] }> {
  const [pane, grants] = await Promise.all([
    prisma.pane.findUnique({
      where: { id: paneId },
      select: { isPublic: true },
    }),
    prisma.paneGrant.findMany({
      where: { paneId },
      orderBy: { createdAt: "asc" },
      select: grantSelect,
    }),
  ]);
  return {
    isPublic: pane?.isPublic ?? false,
    grants: grants.map(toGrantDTO),
  };
}

/**
 * Invite by email — upsert keyed on (paneId, inviteEmail), or update the
 * already-bound (paneId, humanId) row when the invitee has logged in before.
 * Role defaults to "participant".
 *
 * `invitedByAnchor` is the audit anchor written to PaneGrant.invitedBy — the
 * owning human when known (agent surface falls back to the agent id for a
 * standalone unclaimed agent). Access flows from the role, not this column.
 */
export async function createGrant(
  prisma: PrismaClient,
  paneId: string,
  input: { email: string; role?: "participant" | "viewer" },
  invitedByAnchor: string,
): Promise<GrantDTO> {
  const email = normalizeEmail(input.email);
  const role = input.role ?? "participant";

  // If the invitee already has a bound grant (humanId set) — e.g. they logged
  // in earlier — update that row by (paneId, humanId). Otherwise upsert the
  // pending row by (paneId, inviteEmail). Resolve the human first so a
  // re-invite of an already-accepted grantee adjusts their role in place.
  const existingHuman = await prisma.human.findUnique({
    where: { email },
    select: { id: true },
  });
  const boundGrant = existingHuman
    ? await prisma.paneGrant.findUnique({
        where: { paneId_humanId: { paneId, humanId: existingHuman.id } },
        select: { id: true },
      })
    : null;

  if (boundGrant) {
    const grant = await prisma.paneGrant.update({
      where: { id: boundGrant.id },
      data: { role, inviteEmail: email },
      select: grantSelect,
    });
    return toGrantDTO(grant);
  }

  const grant = await prisma.paneGrant.upsert({
    where: { paneId_inviteEmail: { paneId, inviteEmail: email } },
    create: {
      paneId,
      inviteEmail: email,
      role,
      invitedBy: invitedByAnchor,
      // Bind immediately if the invitee already has a (verified or not)
      // Human row — saves a round-trip; the magic-link path also binds.
      ...(existingHuman
        ? { humanId: existingHuman.id, acceptedAt: new Date() }
        : {}),
    },
    update: { role },
    select: grantSelect,
  });
  return toGrantDTO(grant);
}

/** Revoke one grant. Idempotent — a missing grant is a no-op. Scoped to the
 *  pane so a grant id from another pane can't be removed via this pane's id. */
export async function deleteGrant(
  prisma: PrismaClient,
  paneId: string,
  grantId: string,
): Promise<void> {
  await prisma.paneGrant.deleteMany({
    where: { id: grantId, paneId },
  });
}
