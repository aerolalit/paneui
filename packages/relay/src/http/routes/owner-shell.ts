// Owner-shell routes — render and drive a pane using the logged-in human's
// session cookie, no participant capability token in the URL.
//
// The capability-token mount (/s/<token>) remains the share-link path: the
// raw token is the auth, and one URL is enough for an unauthenticated human
// (or one logged in as someone else) to see + interact with the pane. The
// owner of a pane, though, IS logged in: they shouldn't have to manage a
// participant token to look at a pane their own agent created. These routes
// give them that — pane-id-keyed URLs gated by the pane_login cookie.
//
//   GET  /panes/:id              shell HTML (calls back to the routes below)
//   GET  /panes/:id/content      iframe template body
//   GET  /panes/:id/presence     agent-presence poll
//   POST /panes/:id/ws-ticket    short-lived WebSocket upgrade ticket
//   POST /panes/:id/attachments  human-side attachment upload
//   GET  /panes/:id/attachments/:attachment_id  human-side attachment download
//
// Author identity: events the owner emits through this shell are still tagged
// with a Participant.identityId (the relay's polymorphic Author model needs
// one). The first time an owner opens /panes/:id we lazy-mint an
// identity-bound Participant for them (humanId = the logged-in human; no raw
// token is ever issued — the row's `tokenHash` is over discarded random
// bytes, so the participant is reachable ONLY through the cookie-authed
// routes). On subsequent visits the same participant is reused, so the
// owner's identity-id is stable and the audit log stays coherent.

import { Hono, type MiddlewareHandler } from "hono";
import type { PrismaClient } from "@prisma/client";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import {
  computeAgentPresence,
  renderShell,
  RUNTIME_JS,
  PERMISSIONS_POLICY,
} from "../../bridge/routes.js";
import {
  generateHumanParticipantToken,
  hashKey,
  keyPrefix,
} from "../../keys.js";
import { issueTicket, TICKET_TTL_MS } from "../../ws/ticket.js";
import { errors } from "../errors.js";
import type { EventSchema, Author } from "../../types.js";
import { prefersHtml } from "../accept.js";

// Mounted at `/panes` in app.ts, so the route paths here are relative
// (`/:id`, `/:id/content`, ...). The `use("*", requireHuman)` then only
// covers paths under that mount point — keeping the auth gate scoped, so a
// wildcard middleware can't accidentally 401 unrelated routes elsewhere.
const ownerShell = new Hono<HumanAuthEnv>();

// Browser-friendly variant of requireHuman: an anonymous GET that prefers
// HTML (i.e. a human typed the URL into their browser) gets a 302 to
// /login?return=<encoded pane path>, mirroring how the identity-bound
// participant bridge already handles the same case at
// src/bridge/routes.ts:238. Without this, anonymous browser access to
// /panes/:id rendered a raw `{"error":{"code":"unauthorized",...}}`
// JSON page — hostile to a human who just wanted the pane to ask
// them to sign in. See #269.
//
// Non-browser callers (curl with default `Accept: */*`, an XHR with
// `Accept: application/json`, anything POST/non-GET) still get the
// existing 401 envelope — they need the structured error to branch on.
const redirectOrRequireHuman: MiddlewareHandler<HumanAuthEnv> = async (
  c,
  next,
) => {
  const accept = c.req.header("Accept");
  // Only GETs make sense to redirect — a POST to /:id/ws-ticket without a
  // cookie is an XHR misuse, not a misnavigated tab; 401 is the right
  // signal there.
  if (c.req.method === "GET" && prefersHtml(accept)) {
    // Resolve the cookie ourselves so we can branch on missing-vs-present
    // before requireHuman gets a chance to throw. We don't reuse
    // resolveHumanOptional because the lookup-side imports would loop;
    // inline the small bit we need.
    const { parseLoginCookie, hashLoginCookie } =
      await import("../../auth/cookie.js");
    const cookieValue = parseLoginCookie(c.req.header("cookie") ?? null);
    if (!cookieValue) {
      return bounceToLogin(c);
    }
    const prisma = c.get("prisma");
    const login = await prisma.login.findUnique({
      where: { cookieHash: hashLoginCookie(cookieValue) },
      include: { human: true },
    });
    if (!login || login.expiresAt < new Date()) {
      return bounceToLogin(c);
    }
    // Valid cookie — set human and continue. lastSeenAt is updated by
    // requireHuman's lookup; we'd be double-updating if we did it here too,
    // so just hand off below.
    c.set("human", login.human);
    return next();
  }
  // Non-GET or non-HTML — fall through to the standard requireHuman path,
  // which throws the JSON 401 envelope on missing/expired cookies.
  return requireHuman(c, next);
};

function bounceToLogin(c: Parameters<MiddlewareHandler<HumanAuthEnv>>[0]) {
  // Reconstruct the original path + query — Hono's c.req.url is absolute.
  const u = new URL(c.req.url);
  const returnTo = u.pathname + u.search;
  return c.redirect(`/login?return=${encodeURIComponent(returnTo)}`, 302);
}

ownerShell.use("*", redirectOrRequireHuman);

// Load a pane by id and assert the logged-in human owns it. Returns the
// pane row (with templateVersion eager-loaded) for downstream handlers.
//
// Ownership: the relay denormalises ownership onto Pane.ownerHumanId —
// computed at create time from agent.ownerHumanId. A revoked agent claim
// doesn't retroactively un-own past panes, but those still need to be
// inaccessible to the new (unclaimed) state; the column is the source of
// truth. A pane whose ownerHumanId is null (legacy / unclaimed) cannot be
// opened through this path — the human has no claim on it.
async function loadOwnedPane(
  prisma: PrismaClient,
  paneId: string,
  humanId: string,
) {
  const pane = await prisma.pane.findUnique({
    where: { id: paneId },
    include: { templateVersion: true },
  });
  if (!pane) throw errors.notFound();
  if (pane.ownerHumanId !== humanId) {
    // Same error oracle as a missing row — don't tell the caller that the
    // pane exists but belongs to someone else.
    throw errors.notFound();
  }
  return pane;
}

// Identity-id reserved for the pane owner's session-mode participant. A
// fixed literal (not the monotonic `h_${N}` used elsewhere) so the existing
// `@@unique([paneId, identityId])` constraint on Participant doubles as
// the dedup gate for this row — only one owner participant ever exists per
// pane, and two concurrent mints from the same owner collide on the
// constraint instead of producing duplicate rows. Distinct from the
// `h_${N}` namespace Phase E's identity-link and public-link routes mint
// from, so an admin reading the audit log can tell "owner's own click" from
// "human invited by email" at a glance.
const OWNER_IDENTITY_ID = "h_owner";

// Lazy-mint (or reuse) the owner's identity-bound participant. The raw token
// is generated only because Participant.tokenHash is `@unique` and required;
// it is NEVER returned to the caller and never persisted in any form besides
// the SHA-256 hash, so the row is reachable only via cookie-authed pane-id
// routes — never via /s/<token>.
//
// Concurrency: `findFirst` + `create` is a classic check-then-act race —
// two concurrent ws-ticket calls (e.g. two tabs the owner opened at once,
// or a rapid mobile/desktop overlap) could both see "no row" and both try
// to create. The `(paneId, identityId)` unique constraint serialises the
// write: the loser gets P2002, we re-`findFirst`, return the winner's row.
// Phase E's identity-link route deliberately allows multiple Participants
// for the same `(paneId, humanId)` (so the owner can mint several
// revocable invite URLs for the same person), so we cannot add a
// `(paneId, humanId)` unique constraint; this is why the
// identity-id-based scheme is the right shape of fix here.
async function getOrCreateOwnerParticipant(
  prisma: PrismaClient,
  paneId: string,
  humanId: string,
): Promise<{ identityId: string; id: string }> {
  // Look up by (paneId, identityId) — the dedup key. We include `humanId`
  // in the lookup as defence-in-depth: a row with our identity-id but a
  // different humanId would be a data-integrity bug, and reusing it would
  // mis-attribute events. In practice the constraint ensures one such row
  // exists per pane and we wrote its humanId ourselves, so this is just
  // a safety belt.
  const existing = await prisma.participant.findFirst({
    where: {
      paneId,
      identityId: OWNER_IDENTITY_ID,
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
        identityId: OWNER_IDENTITY_ID,
        tokenHash: hashKey(tok),
        tokenPrefix: keyPrefix(tok),
        humanId,
      },
      select: { id: true, identityId: true },
    });
    return created;
  } catch (e) {
    // Narrow to the identity-id collision (the race we're handling). Other
    // P2002s — most plausibly an astronomically unlikely tokenHash collision
    // — would indicate a real bug, so we let them bubble. The collision
    // fingerprint is engine-dependent (see panes.ts:854-873 for the same
    // analysis); we match either Prisma 6's `target` array or Prisma 7's
    // message-body form.
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

    // Re-query — the racing call won the row; reuse it.
    const winner = await prisma.participant.findFirst({
      where: {
        paneId,
        identityId: OWNER_IDENTITY_ID,
        humanId,
        kind: "human",
        revokedAt: null,
      },
      select: { id: true, identityId: true },
    });
    if (!winner) {
      // The race resolved against us but the row isn't there on re-query.
      // Either it was revoked between the P2002 and the re-query (acceptable
      // — the next call will mint a new one) or there's a deeper consistency
      // bug. Rethrow the original error so the operator notices.
      throw e;
    }
    return winner;
  }
}

// GET /panes/:id — shell HTML for the owner.
ownerShell.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const human = c.get("human");
  const id = c.req.param("id");
  const pane = await loadOwnedPane(prisma, id, human.id);

  const { agentLive, agentLastEventAt, agentLastUsedAt } =
    await computeAgentPresence(prisma, pane);
  const isClosed =
    pane.status !== "open" || pane.expiresAt.getTime() < Date.now();

  // Same wsUrl construction as the capability-token mount. WS auth itself
  // happens via a single-use ticket the shell mints right before connecting
  // (see POST /panes/:id/ws-ticket below) — the cookie never travels in a
  // WebSocket query string.
  const wsBase = config.publicUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
  const wsUrl = wsBase.replace(/\/$/, "") + `/v1/panes/${pane.id}/stream`;

  const schema = pane.templateVersion.eventSchema as unknown as EventSchema;
  const nonceBuf = new Uint8Array(16);
  crypto.getRandomValues(nonceBuf);
  const nonce = Buffer.from(nonceBuf).toString("base64url");

  // Same security headers as the capability-token shell — copied from
  // src/bridge/routes.ts so the two mounts never drift on what the page is
  // allowed to do. The only relevant difference is the absence of
  // 'connect-src' to the participant-token endpoints (there are none in this
  // mode); session-mode fetches all stay under 'self'.
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
      `connect-src 'self' ${wsBase.replace(/\/$/, "")}`,
      "frame-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Permissions-Policy", PERMISSIONS_POLICY);
  c.header("Cache-Control", "private, no-store");
  c.header("Content-Type", "text/html; charset=utf-8");

  const idSeg = `/panes/${encodeURIComponent(pane.id)}`;
  return c.body(
    renderShell({
      nonce,
      paneId: pane.id,
      iframeContentUrl: `${idSeg}/content`,
      presenceUrl: `${idSeg}/presence`,
      wsTicketUrl: `${idSeg}/ws-ticket`,
      // Session mode: pane_login cookie does the auth — no Authorization header.
      wsTicketAuthorization: null,
      attachmentsUploadUrl: `${idSeg}/attachments`,
      attachmentsDownloadUrlBase: `${idSeg}/attachments`,
      schema,
      inputData: pane.inputData ?? null,
      wsUrl,
      isClosed,
      agentLive,
      agentLastEventAt,
      agentLastUsedAt,
      title: pane.title,
      preamble: pane.preamble,
      // Same dark top nav the system pages render on /home, /my-panes,
      // etc. — the owner came here from one of those pages and needs a way
      // back without using the browser back button.
      topNav: { email: human.email, active: "panes" },
    }),
  );
});

// GET /panes/:id/content — iframe template body (cookie-authed mirror of
// GET /s/:token/content).
ownerShell.get("/:id/content", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  const pane = await loadOwnedPane(prisma, id, human.id);

  // Same closed-pane gate as the capability mount. The shell page already
  // renders a "closed" banner when isClosed, but a client that bookmarked
  // /content directly would otherwise still receive the template until the
  // pane was deleted.
  if (pane.status !== "open" || pane.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  let artifactBody: string;
  if (pane.templateVersion.templateType === "html-inline") {
    artifactBody = pane.templateVersion.templateSource;
  } else {
    // html-ref is rejected at POST /v1/panes — kept here as defence-in-depth.
    artifactBody = "<!-- template.type=html-ref is not implemented in v1 -->";
  }

  // Identical iframe-content CSP to the capability-token mount — the iframe
  // sandbox is the primary trust boundary; CSP is belt-and-braces.
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data: attachment:",
      "media-src attachment:",
      "font-src data:",
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Permissions-Policy", PERMISSIONS_POLICY);
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "private, no-store");

  const wrapped = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>${RUNTIME_JS}</script>
</head>
<body>
${artifactBody}
</body>
</html>`;
  return c.body(wrapped);
});

// GET /panes/:id/presence — agent-presence poll (cookie-authed mirror of
// GET /s/:token/presence). Same computeAgentPresence so the two endpoints
// can never diverge on what "active" means.
ownerShell.get("/:id/presence", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  const pane = await loadOwnedPane(prisma, id, human.id);

  const presence = await computeAgentPresence(prisma, pane);

  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(JSON.stringify(presence));
});

// POST /panes/:id/ws-ticket — short-lived single-use WebSocket upgrade
// ticket bound to the owner's identity. Lazy-mints the owner's Participant
// row on first use so the WS handler's joinedAt update + the events.authorId
// log have a stable identity-id for this owner.
ownerShell.post("/:id/ws-ticket", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  const pane = await loadOwnedPane(prisma, id, human.id);

  if (pane.status !== "open" || pane.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  const participant = await getOrCreateOwnerParticipant(
    prisma,
    pane.id,
    human.id,
  );
  const author: Author = { kind: "human", id: participant.identityId };
  const ticket = issueTicket(author, pane.id);
  return c.json(
    {
      ticket,
      expires_at: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    },
    201,
  );
});

// Attachments are intentionally NOT yet wired through this mount. The capability-
// token paths (POST /s/:token/attachments + GET /s/:token/attachments/:id) own
// substantial pipeline + decrypt logic that needs a small extraction before it
// can be cleanly invoked with a session-resolved pane; that extraction is the
// next change on this branch. Templates that try to upload/download attachments
// from /panes/:id will hit a 404 from this mount and can fall back to the
// share-link URL until the follow-up commit lands. The shell config's
// `attachmentsUploadUrl` / `attachmentsDownloadUrlBase` still point at the
// id-keyed paths so no client-side change is needed when the routes appear.

export default ownerShell;
