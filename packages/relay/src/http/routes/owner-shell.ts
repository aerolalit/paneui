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
  OWNER_IDENTITY_ID,
  getOrCreateIdentityParticipant,
} from "./identity-participant.js";
import { issueTicket, TICKET_TTL_MS } from "../../ws/ticket.js";
import { recordView } from "../../bridge/recents.js";
import { buildPaneCsp, paneCspImgOrigin } from "../../bridge/preview-render.js";
import { errors } from "../errors.js";
import { log } from "../../log.js";
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
  // #305 — a soft-deleted pane is treated as "not found" for the owner-
  // shell pages. Visiting /panes/:id on a trashed pane mints a fresh
  // participant token and opens the iframe; both would fight with the
  // hard-delete sweeper and look like flapping to the user. The /trash UI
  // (#306) is the one place a trashed pane should be viewable.
  if (pane.deletedAt !== null) throw errors.notFound();
  return pane;
}

// The owner's session-mode participant is minted via the shared
// getOrCreateIdentityParticipant helper under the OWNER_IDENTITY_ID slot.
// See src/http/routes/identity-participant.ts for the concurrency + token
// handling. The same helper backs the `participant`-role grantee on the
// /p/:paneId mount, so the two never drift.

// GET /panes/:id — shell HTML for the owner.
ownerShell.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const human = c.get("human");
  const id = c.req.param("id");
  const pane = await loadOwnedPane(prisma, id, human.id);

  // Recents: record the owner's open. Best-effort — never block the page.
  recordView(prisma, human.id, pane.id).catch((err: unknown) =>
    log.warn("recordView failed (owner-shell)", {
      paneId: pane.id,
      humanId: human.id,
      error: String(err),
    }),
  );

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
      // Slim account bar (brand + presence + Share + sign out). The brand
      // logo links back to /home; system-page tabs are intentionally omitted
      // here so the pane viewer stays a focused single-pane surface. canShare
      // is true: this mount is owner-only (loadOwnedPane asserts ownership), so
      // the Share button is safe to surface here and nowhere else.
      topNav: { canShare: true },
      // Owner mount keeps the static robot home-screen icon. The per-pane icon
      // route (/s/<token>/icon.png) is token-authed; an owner equivalent would
      // be cookie-gated, and iOS may fetch apple-touch-icon without the cookie,
      // so a 401 there would yield no icon at all (worse than the robot).
      appleTouchIconHref: "/apple-touch-icon.png",
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

  // Identical iframe-content CSP to the capability-token mount (buildPaneCsp,
  // single source of truth) — the iframe sandbox is the primary trust boundary;
  // CSP is belt-and-braces. The relay origin in img-src/media-src lets a
  // template render attachment bytes from a `/b/<token>` capability URL.
  c.header(
    "Content-Security-Policy",
    buildPaneCsp(paneCspImgOrigin(c.get("config").publicUrl)),
  );
  c.header("X-Content-Type-Options", "nosniff");
  // Keep capability tokens in `<img src>` out of any `Referer`.
  c.header("Referrer-Policy", "no-referrer");
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

  const participant = await getOrCreateIdentityParticipant(
    prisma,
    pane.id,
    human.id,
    OWNER_IDENTITY_ID,
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
