// Hourly hard-delete sweeper (#304) — reclaims rows that have been soft-
// deleted long enough that the retention window has elapsed.
//
// Tier-aware: each entity's retention window is resolved per row based on
// the owning human's tier + per-row overrides (see config #308 +
// schema #302). The four operative knobs:
//
//   1. humans.hard_retention_days IS NOT NULL → use it (per-row override)
//   2. humans.tier = 'paid' → HARD_RETENTION_DAYS_PAID (default null = never)
//   3. humans.tier = 'system' → never (immune)
//   4. otherwise (free / no human owner) → HARD_RETENTION_DAYS_FREE (30d)
//
// Entities cascade naturally via Prisma's onDelete: Cascade — pane
// hard-delete takes events / participants / record_collections /
// pane_records with it. Attachments are special: we must also purge
// the blob bytes from the AttachmentStore, not just the row.
//
// Anonymous-template orphan cleanup lives here too (lifted from the old
// `sweepExpiredPanes` in `index.ts`): after pane hard-deletes, any
// anonymous template (name + slug both null) with zero remaining pane
// references is also reclaimed. Under soft-delete (the pre-#304 state),
// those templates were never cleaned up; #304 closes that gap.
//
// Each hard-delete appends one `deletion_log` row with
// `phase='hard_deleted'`, `reason='retention_window_elapsed'`. The audit
// row outlives the entity (no FK back to it).

import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import { log } from "./log.js";
import type { AttachmentStore } from "./attachments/store.js";

/** Per-pass cap per entity type so a single tick can't starve the event loop. */
const HARD_DELETE_BATCH = 500;

export interface HardDeleteResult {
  panes: number;
  attachments: number;
  templates: number;
  agents: number;
  humans: number;
}

export interface HardDeleteDeps {
  prisma: PrismaClient;
  config: Pick<Config, "HARD_RETENTION_DAYS_FREE" | "HARD_RETENTION_DAYS_PAID">;
  /**
   * AttachmentStore for purging blob bytes when an Attachment is hard-
   * deleted. Optional only because tests can skip the blob-store wiring;
   * production always passes one.
   */
  attachmentStore?: AttachmentStore;
}

/**
 * One pass of the hard-delete sweep. Returns per-entity-type counts.
 *
 * Order matters: children first (panes, attachments) so cascades don't
 * fight us. Anonymous-template orphan cleanup runs after panes.
 */
export async function sweepHardDeletable(
  deps: HardDeleteDeps,
): Promise<HardDeleteResult> {
  const { prisma, config } = deps;
  const now = new Date();

  // Compute "free" and "paid" cutoff dates once. tier='system' is checked
  // in code (never hard-delete). Per-row override is checked in code too,
  // because Prisma can't express "use this column if non-null else use a
  // tier-conditional constant" in one query.
  const freeCutoff = new Date(
    now.getTime() - config.HARD_RETENTION_DAYS_FREE * 24 * 60 * 60 * 1000,
  );
  const paidCutoff =
    config.HARD_RETENTION_DAYS_PAID === null
      ? null
      : new Date(
          now.getTime() - config.HARD_RETENTION_DAYS_PAID * 24 * 60 * 60 * 1000,
        );

  // ---- 1. PANES ------------------------------------------------------
  // Panes own their child entities via Prisma cascades, so deleting a
  // pane ripples through events / participants / record_collections /
  // pane_records / feedback / attachments-of-this-pane automatically.
  const panesSwept = await sweepPanes(prisma, freeCutoff, paidCutoff);

  // No template orphan reclamation: every template is named (name is NOT
  // NULL — see the require_template_name migration), so a template is a
  // reusable identity that outlives its instances. Inline one-off panes
  // create named templates too, so they now persist after their pane
  // expires rather than being garbage-collected as anonymous orphans (the
  // prior behaviour, removed with the anonymous-template concept).

  // ---- 2. ATTACHMENTS ---------------------------------------------------
  // Attachment-scoped trash (soft-deleted attachments past retention).
  // attachment.owner is an Agent; retention resolves against that agent's
  // owner_human (which may be null = free default).
  const attachmentsSwept = await sweepAttachments(
    prisma,
    freeCutoff,
    paidCutoff,
    deps.attachmentStore,
  );

  // ---- 4. TEMPLATES (named, soft-deleted) -------------------------------
  // Named templates can be user-soft-deleted via the trash API (#306).
  // Anonymous-orphan cleanup above is a separate path. The template's
  // own retention window resolves against the template's owner (agent),
  // matching the attachment path.
  const templatesSwept = await sweepTemplates(prisma, freeCutoff, paidCutoff);

  // ---- 5. AGENTS --------------------------------------------------------
  // Soft-deleted agents past retention. NOTE: agents do NOT cascade to their
  // owned rows. Pane.agent, Template.owner, and Attachment.owner are required
  // relations with no `onDelete` → Prisma default `Restrict`; Feedback.agent
  // is `SetNull`. So deleting an agent neither deletes nor frees its owned
  // panes/templates/attachments.
  //
  // GUARD (#506): sweepAgents only hard-deletes agents owning ZERO Restrict-
  // protected children (`panes`/`templates`/`attachments` of ANY status). An
  // agent that still owns one is DEFERRED to a later pass rather than purged;
  // its children are reclaimed in the panes → attachments → templates phases
  // above, and once they're gone the next pass picks the agent up. This makes
  // the flat `agent.deleteMany` FK-safe — without the guard it would throw a
  // P2003 FK-restrict error and abort the whole pass the moment an account-
  // deletion path starts soft-deleting agents that still own children (dormant
  // today: nothing sets `deletedAt` on an agent yet). The deferral count is
  // logged for observability so a wedged agent isn't a silent black hole.
  //
  // This guard is a SAFETY net, not the deletion semantics. The real cascade-
  // on-account-deletion (purge an agent's panes/templates/attachments —
  // including blob bytes + deletionLog audit rows — when the account is
  // deleted) belongs to the retention epic #312, NOT here. We deliberately do
  // NOT add `onDelete: Cascade` to those FKs: cascading attachment ROWS would
  // leak their blob BYTES (no orphaned-blob GC exists; bytes are only purged at
  // explicit delete points) and skip the deletionLog audit.
  const agentsSwept = await sweepAgents(prisma, freeCutoff, paidCutoff);

  // ---- 6. HUMANS --------------------------------------------------------
  // Self-soft-deleted humans past retention. NO guard needed here (unlike
  // sweepAgents): a flat `human.deleteMany` cannot throw a P2003 FK-restrict
  // error because every child relation of Human is either Cascade or SetNull,
  // never Restrict. Login, ClaimCode, HumanTemplateInstall, and
  // HumanPaneFavorite are all `onDelete: Cascade` (rows go with the human);
  // Agent.ownerHuman is `onDelete: SetNull`, so deleting a human only nulls
  // each claimed agent's ownerHumanId, leaving the agent (and its panes/
  // templates) alive. Do NOT copy the sweepAgents guard here — there is no
  // restricted child to defer on. tier='system' never reaches this — the
  // predicate explicitly excludes it.
  const humansSwept = await sweepHumans(prisma, freeCutoff, paidCutoff);

  const result: HardDeleteResult = {
    panes: panesSwept,
    attachments: attachmentsSwept,
    templates: templatesSwept,
    agents: agentsSwept,
    humans: humansSwept,
  };

  const total =
    result.panes +
    result.attachments +
    result.templates +
    result.agents +
    result.humans;
  if (total > 0) {
    log.info("hard-delete sweeper pass", { ...result });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-entity sweeps
// ---------------------------------------------------------------------------

interface RetentionRow {
  id: string;
  deletedAt: Date | null;
  ownerHumanId: string | null;
  ownerAgentId: string | null;
  tier: string | null; // owner human's tier
  hardRetentionDays: number | null; // owner human's override
}

/** Predicate: is this soft-deleted row past its (tier-resolved) retention? */
function isPastRetention(
  row: RetentionRow,
  now: Date,
  freeCutoff: Date,
  paidCutoff: Date | null,
): boolean {
  if (row.deletedAt === null) return false;
  if (row.tier === "system") return false;
  // Per-row override beats tier default.
  if (row.hardRetentionDays !== null) {
    const cutoff = new Date(
      now.getTime() - row.hardRetentionDays * 24 * 60 * 60 * 1000,
    );
    return row.deletedAt < cutoff;
  }
  if (row.tier === "paid") {
    if (paidCutoff === null) return false; // paid + no env override = never
    return row.deletedAt < paidCutoff;
  }
  // Free, or no human owner.
  return row.deletedAt < freeCutoff;
}

async function sweepPanes(
  prisma: PrismaClient,
  freeCutoff: Date,
  paidCutoff: Date | null,
): Promise<number> {
  // Candidate query: every soft-deleted pane. We filter by tier-aware
  // retention in JS because the per-row override + tier conditional doesn't
  // express cleanly in Prisma's where. Batched at HARD_DELETE_BATCH; a
  // future pass picks up overflow.
  const candidates = await prisma.pane.findMany({
    where: { deletedAt: { not: null } },
    select: {
      id: true,
      deletedAt: true,
      ownerHumanId: true,
      agentId: true,
      ownerHuman: { select: { tier: true, hardRetentionDays: true } },
    },
    take: HARD_DELETE_BATCH * 2, // overshoot to give the JS filter slack
  });
  const now = new Date();
  const targets = candidates.filter((s) =>
    isPastRetention(
      {
        id: s.id,
        deletedAt: s.deletedAt,
        ownerHumanId: s.ownerHumanId,
        ownerAgentId: s.agentId,
        tier: s.ownerHuman?.tier ?? null,
        hardRetentionDays: s.ownerHuman?.hardRetentionDays ?? null,
      },
      now,
      freeCutoff,
      paidCutoff,
    ),
  );
  if (targets.length === 0) return 0;

  const ids = targets.slice(0, HARD_DELETE_BATCH).map((s) => s.id);

  // Append audit rows BEFORE the cascade-delete so we don't need to
  // re-look-up owner anchors after the row is gone.
  await prisma.deletionLog.createMany({
    data: targets.slice(0, HARD_DELETE_BATCH).map((s) => ({
      entityType: "pane",
      entityId: s.id,
      ownerHumanId: s.ownerHumanId,
      ownerAgentId: s.agentId,
      phase: "hard_deleted",
      reason: "retention_window_elapsed",
    })),
  });

  const r = await prisma.pane.deleteMany({ where: { id: { in: ids } } });
  return r.count;
}

async function sweepAttachments(
  prisma: PrismaClient,
  freeCutoff: Date,
  paidCutoff: Date | null,
  attachmentStore: AttachmentStore | undefined,
): Promise<number> {
  // attachment.owner is an Agent; retention resolves against that agent's
  // owner_human. Standalone agents (no human owner) get the free default.
  const candidates = await prisma.attachment.findMany({
    where: { deletedAt: { not: null } },
    select: {
      id: true,
      deletedAt: true,
      storageKey: true,
      ownerId: true,
      owner: {
        select: {
          ownerHumanId: true,
          ownerHuman: { select: { tier: true, hardRetentionDays: true } },
        },
      },
    },
    take: HARD_DELETE_BATCH * 2,
  });
  const now = new Date();
  const targets = candidates.filter((a) =>
    isPastRetention(
      {
        id: a.id,
        deletedAt: a.deletedAt,
        ownerHumanId: a.owner.ownerHumanId,
        ownerAgentId: a.ownerId,
        tier: a.owner.ownerHuman?.tier ?? null,
        hardRetentionDays: a.owner.ownerHuman?.hardRetentionDays ?? null,
      },
      now,
      freeCutoff,
      paidCutoff,
    ),
  );
  if (targets.length === 0) return 0;

  const slice = targets.slice(0, HARD_DELETE_BATCH);

  await prisma.deletionLog.createMany({
    data: slice.map((a) => ({
      entityType: "attachment",
      entityId: a.id,
      ownerHumanId: a.owner.ownerHumanId,
      ownerAgentId: a.ownerId,
      phase: "hard_deleted",
      reason: "retention_window_elapsed",
    })),
  });

  const r = await prisma.attachment.deleteMany({
    where: { id: { in: slice.map((a) => a.id) } },
  });

  // Purge blob bytes from the AttachmentStore. Best-effort: per-row
  // failures log a warn but don't roll back the row delete. The store
  // is idempotent so repeated tries on a stale key are safe.
  if (attachmentStore) {
    for (const a of slice) {
      try {
        await attachmentStore.delete(a.storageKey);
      } catch (e) {
        log.warn("attachment blob purge failed", {
          attachmentId: a.id,
          storageKey: a.storageKey,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return r.count;
}

async function sweepTemplates(
  prisma: PrismaClient,
  freeCutoff: Date,
  paidCutoff: Date | null,
): Promise<number> {
  const candidates = await prisma.template.findMany({
    where: { deletedAt: { not: null } },
    select: {
      id: true,
      deletedAt: true,
      ownerId: true,
      owner: {
        select: {
          ownerHumanId: true,
          ownerHuman: { select: { tier: true, hardRetentionDays: true } },
        },
      },
    },
    take: HARD_DELETE_BATCH * 2,
  });
  const now = new Date();
  const targets = candidates.filter((t) =>
    isPastRetention(
      {
        id: t.id,
        deletedAt: t.deletedAt,
        ownerHumanId: t.owner.ownerHumanId,
        ownerAgentId: t.ownerId,
        tier: t.owner.ownerHuman?.tier ?? null,
        hardRetentionDays: t.owner.ownerHuman?.hardRetentionDays ?? null,
      },
      now,
      freeCutoff,
      paidCutoff,
    ),
  );
  if (targets.length === 0) return 0;

  const slice = targets.slice(0, HARD_DELETE_BATCH);

  await prisma.deletionLog.createMany({
    data: slice.map((t) => ({
      entityType: "template",
      entityId: t.id,
      ownerHumanId: t.owner.ownerHumanId,
      ownerAgentId: t.ownerId,
      phase: "hard_deleted",
      reason: "retention_window_elapsed",
    })),
  });
  const r = await prisma.template.deleteMany({
    where: { id: { in: slice.map((t) => t.id) } },
  });
  return r.count;
}

async function sweepAgents(
  prisma: PrismaClient,
  freeCutoff: Date,
  paidCutoff: Date | null,
): Promise<number> {
  // Agents may or may not have an owner human. Standalone agents (CI bots,
  // scratch scripts) get the free default.
  //
  // GUARD (#506): only consider agents that own ZERO Restrict-protected
  // children. Pane.agent / Template.owner / Attachment.owner are required FKs
  // with the Prisma default `onDelete: Restrict`, so a flat `agent.deleteMany`
  // over an agent that still owns any pane/template/attachment throws P2003 and
  // aborts the whole pass. We exclude such agents with `<rel>: { none: {} }` so
  // the eligible set is FK-safe. The relation filters match ANY status — a
  // soft-deleted-but-not-yet-swept child row still holds the FK, so it must
  // still defer its agent. A skipped agent is reclaimed in a later pass once its
  // children have been swept (children run in earlier phases of this same pass).
  const candidates = await prisma.agent.findMany({
    where: {
      deletedAt: { not: null },
      panes: { none: {} },
      templates: { none: {} },
      attachments: { none: {} },
    },
    select: {
      id: true,
      deletedAt: true,
      ownerHumanId: true,
      ownerHuman: { select: { tier: true, hardRetentionDays: true } },
    },
    take: HARD_DELETE_BATCH * 2,
  });

  // Observability: count soft-deleted, past-retention agents we DEFERRED purely
  // because they still own Restrict-protected children. Without this, a wedged
  // agent (child never swept) is an invisible "never deleted" black hole. The
  // count is the gap between "eligible by retention" and "FK-safe by guard".
  const blockedRetained = await prisma.agent.findMany({
    where: {
      deletedAt: { not: null },
      OR: [
        { panes: { some: {} } },
        { templates: { some: {} } },
        { attachments: { some: {} } },
      ],
    },
    select: {
      id: true,
      deletedAt: true,
      ownerHumanId: true,
      ownerHuman: { select: { tier: true, hardRetentionDays: true } },
    },
    take: HARD_DELETE_BATCH * 2,
  });
  const now = new Date();
  const targets = candidates.filter((a) =>
    isPastRetention(
      {
        id: a.id,
        deletedAt: a.deletedAt,
        ownerHumanId: a.ownerHumanId,
        ownerAgentId: a.id,
        tier: a.ownerHuman?.tier ?? null,
        hardRetentionDays: a.ownerHuman?.hardRetentionDays ?? null,
      },
      now,
      freeCutoff,
      paidCutoff,
    ),
  );

  // Same retention predicate applied to the child-owning set, so the deferred
  // count reflects agents that WOULD be reclaimed if not for the FK guard.
  const deferred = blockedRetained.filter((a) =>
    isPastRetention(
      {
        id: a.id,
        deletedAt: a.deletedAt,
        ownerHumanId: a.ownerHumanId,
        ownerAgentId: a.id,
        tier: a.ownerHuman?.tier ?? null,
        hardRetentionDays: a.ownerHuman?.hardRetentionDays ?? null,
      },
      now,
      freeCutoff,
      paidCutoff,
    ),
  ).length;
  if (deferred > 0) {
    log.info("hard-delete sweeper: agents deferred (still own children)", {
      deferred,
    });
  }

  if (targets.length === 0) return 0;

  const slice = targets.slice(0, HARD_DELETE_BATCH);

  await prisma.deletionLog.createMany({
    data: slice.map((a) => ({
      entityType: "agent",
      entityId: a.id,
      ownerHumanId: a.ownerHumanId,
      ownerAgentId: a.id,
      phase: "hard_deleted",
      reason: "retention_window_elapsed",
    })),
  });
  const r = await prisma.agent.deleteMany({
    where: { id: { in: slice.map((a) => a.id) } },
  });
  return r.count;
}

async function sweepHumans(
  prisma: PrismaClient,
  freeCutoff: Date,
  paidCutoff: Date | null,
): Promise<number> {
  // For humans, the human IS the owner — their own tier + override apply.
  // tier='system' rows are not soft-deletable in practice (the relay's
  // self-delete route refuses); the predicate excludes them regardless.
  const candidates = await prisma.human.findMany({
    where: { deletedAt: { not: null } },
    select: {
      id: true,
      deletedAt: true,
      tier: true,
      hardRetentionDays: true,
    },
    take: HARD_DELETE_BATCH * 2,
  });
  const now = new Date();
  const targets = candidates.filter((h) =>
    isPastRetention(
      {
        id: h.id,
        deletedAt: h.deletedAt,
        ownerHumanId: h.id,
        ownerAgentId: null,
        tier: h.tier,
        hardRetentionDays: h.hardRetentionDays,
      },
      now,
      freeCutoff,
      paidCutoff,
    ),
  );
  if (targets.length === 0) return 0;

  const slice = targets.slice(0, HARD_DELETE_BATCH);

  await prisma.deletionLog.createMany({
    data: slice.map((h) => ({
      entityType: "human",
      entityId: h.id,
      ownerHumanId: h.id,
      ownerAgentId: null,
      phase: "hard_deleted",
      reason: "retention_window_elapsed",
    })),
  });
  const r = await prisma.human.deleteMany({
    where: { id: { in: slice.map((h) => h.id) } },
  });
  return r.count;
}
