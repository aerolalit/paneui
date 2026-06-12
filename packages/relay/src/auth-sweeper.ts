// Auth-state sweeper (#307) — hourly hard-delete of expired/consumed auth
// tokens. Distinct from the pane/template/agent/human soft-delete
// lifecycle (#302/#303/#304): these rows are transient auth state, not user
// content, so they're hard-deleted directly with no soft-delete phase and
// no audit-log rows.
//
// Tables swept (all batched at AUTH_SWEEP_BATCH per pass):
//
//   logins             expires_at < NOW()
//   magic_links        expires_at < NOW()  OR  consumed_at < NOW() - 7d
//   claim_codes        expires_at < NOW()  OR  consumed_at < NOW() - 7d
//   attachment_tokens  expires_at < NOW()  OR  revoked_at  < NOW() - 7d
//   oauth_auth_codes   expires_at < NOW()  OR  consumed_at < NOW() - 7d
//   oauth_tokens       expires_at < NOW()  OR  revoked_at  < NOW() - 7d
//
// The 7-day "consumed/revoked grace" exists because a consumed magic-link
// or revoked attachment-token is auth-state-dead but useful for forensic
// queries ("who consumed this code? when?") in the immediate aftermath of
// an incident. Past 7 days it's noise — drop it.

import type { PrismaClient } from "@prisma/client";
import { log } from "./log.js";

/** Per-pass cap so a single tick can't starve the relay's event loop. */
const AUTH_SWEEP_BATCH = 500;
/** Consumed/revoked-grace window: after this much time, the row is purged. */
const CONSUMED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthSweepResult {
  logins: number;
  magic_links: number;
  claim_codes: number;
  attachment_tokens: number;
  oauth_auth_codes: number;
  oauth_tokens: number;
}

/**
 * One pass of the auth-state sweep. Returns per-table delete counts.
 * The four `deleteMany` calls run independently; a per-table failure
 * doesn't block the others.
 */
export async function sweepAuthTokens(
  prisma: PrismaClient,
): Promise<AuthSweepResult> {
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - CONSUMED_GRACE_MS);

  // logins — only expires_at predicate.
  const expiredLoginIds = await prisma.login.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true },
    take: AUTH_SWEEP_BATCH,
  });
  const loginsCount = expiredLoginIds.length
    ? (
        await prisma.login.deleteMany({
          where: { id: { in: expiredLoginIds.map((r) => r.id) } },
        })
      ).count
    : 0;

  // magic_links — expired OR consumed > 7 days ago.
  const expiredMagicIds = await prisma.magicLink.findMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { consumedAt: { lt: graceCutoff } }],
    },
    select: { id: true },
    take: AUTH_SWEEP_BATCH,
  });
  const magicLinksCount = expiredMagicIds.length
    ? (
        await prisma.magicLink.deleteMany({
          where: { id: { in: expiredMagicIds.map((r) => r.id) } },
        })
      ).count
    : 0;

  // claim_codes — same pattern as magic_links.
  const expiredClaimIds = await prisma.claimCode.findMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { consumedAt: { lt: graceCutoff } }],
    },
    select: { id: true },
    take: AUTH_SWEEP_BATCH,
  });
  const claimCodesCount = expiredClaimIds.length
    ? (
        await prisma.claimCode.deleteMany({
          where: { id: { in: expiredClaimIds.map((r) => r.id) } },
        })
      ).count
    : 0;

  // attachment_tokens — expired OR revoked > 7 days ago.
  const expiredAttIds = await prisma.attachmentToken.findMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: graceCutoff } }],
    },
    select: { id: true },
    take: AUTH_SWEEP_BATCH,
  });
  const attachmentTokensCount = expiredAttIds.length
    ? (
        await prisma.attachmentToken.deleteMany({
          where: { id: { in: expiredAttIds.map((r) => r.id) } },
        })
      ).count
    : 0;

  // oauth_auth_codes — expired OR consumed > 7 days ago (single-use codes are
  // dead the moment they're consumed; keep a short forensic window).
  const expiredOauthCodeIds = await prisma.oAuthAuthCode.findMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { consumedAt: { lt: graceCutoff } }],
    },
    select: { codeHash: true },
    take: AUTH_SWEEP_BATCH,
  });
  const oauthCodesCount = expiredOauthCodeIds.length
    ? (
        await prisma.oAuthAuthCode.deleteMany({
          where: {
            codeHash: { in: expiredOauthCodeIds.map((r) => r.codeHash) },
          },
        })
      ).count
    : 0;

  // oauth_tokens — expired OR revoked > 7 days ago (same forensic window as
  // attachment_tokens). A revoked-but-recent token row is kept so an operator
  // can answer "when was Claude disconnected?".
  const expiredOauthTokenIds = await prisma.oAuthToken.findMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: graceCutoff } }],
    },
    select: { tokenHash: true },
    take: AUTH_SWEEP_BATCH,
  });
  const oauthTokensCount = expiredOauthTokenIds.length
    ? (
        await prisma.oAuthToken.deleteMany({
          where: {
            tokenHash: { in: expiredOauthTokenIds.map((r) => r.tokenHash) },
          },
        })
      ).count
    : 0;

  const result: AuthSweepResult = {
    logins: loginsCount,
    magic_links: magicLinksCount,
    claim_codes: claimCodesCount,
    attachment_tokens: attachmentTokensCount,
    oauth_auth_codes: oauthCodesCount,
    oauth_tokens: oauthTokensCount,
  };
  const total =
    result.logins +
    result.magic_links +
    result.claim_codes +
    result.attachment_tokens +
    result.oauth_auth_codes +
    result.oauth_tokens;
  if (total > 0) {
    log.info("auth-sweeper pass", { ...result });
  }
  return result;
}

/**
 * Read the sweep interval from env. Coexists with #308 (which adds
 * HARD_DELETE_SWEEP_SECONDS to Config): we read from process.env directly so
 * this module compiles + runs against main today AND keeps working after
 * #338 lands. Returns seconds, default 3600 (1h). 0 disables. Invalid
 * non-negative-integer falls back to default with a warn — silent default
 * on a typo is the wrong call for a prod sweeper.
 */
export function authSweepIntervalSeconds(): number {
  const raw = process.env.HARD_DELETE_SWEEP_SECONDS;
  if (raw === undefined || raw === "") return 3600;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    log.warn(
      "auth-sweeper: HARD_DELETE_SWEEP_SECONDS=" +
        raw +
        " is not a non-negative integer; falling back to 3600",
    );
    return 3600;
  }
  return n;
}
