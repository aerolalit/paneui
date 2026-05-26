// Owner-shell routes — render and drive a surface using the logged-in human's
// session cookie, no participant capability token in the URL.
//
// The capability-token mount (/s/<token>) remains the share-link path: the
// raw token is the auth, and one URL is enough for an unauthenticated human
// (or one logged in as someone else) to see + interact with the surface. The
// owner of a surface, though, IS logged in: they shouldn't have to manage a
// participant token to look at a pane their own agent created. These routes
// give them that — surface-id-keyed URLs gated by the pane_login cookie.
//
//   GET  /surfaces/:id              shell HTML (calls back to the routes below)
//   GET  /surfaces/:id/content      iframe template body
//   GET  /surfaces/:id/presence     agent-presence poll
//   POST /surfaces/:id/ws-ticket    short-lived WebSocket upgrade ticket
//   POST /surfaces/:id/attachments  human-side attachment upload
//   GET  /surfaces/:id/attachments/:attachment_id  human-side attachment download
//
// Author identity: events the owner emits through this shell are still tagged
// with a Participant.identityId (the relay's polymorphic Author model needs
// one). The first time an owner opens /surfaces/:id we lazy-mint an
// identity-bound Participant for them (humanId = the logged-in human; no raw
// token is ever issued — the row's `tokenHash` is over discarded random
// bytes, so the participant is reachable ONLY through the cookie-authed
// routes). On subsequent visits the same participant is reused, so the
// owner's identity-id is stable and the audit log stays coherent.

import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import {
  computeAgentPresence,
  renderShell,
  SHIM_JS,
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

// Mounted at `/surfaces` in app.ts, so the route paths here are relative
// (`/:id`, `/:id/content`, ...). The `use("*", requireHuman)` then only
// covers paths under that mount point — keeping the auth gate scoped, so a
// wildcard middleware can't accidentally 401 unrelated routes elsewhere.
const ownerShell = new Hono<HumanAuthEnv>();

// All routes in this module require a valid pane_login cookie. requireHuman
// throws 401 + clears the cookie if the session is missing or expired.
ownerShell.use("*", requireHuman);

// Load a surface by id and assert the logged-in human owns it. Returns the
// surface row (with templateVersion eager-loaded) for downstream handlers.
//
// Ownership: the relay denormalises ownership onto Surface.ownerHumanId —
// computed at create time from agent.ownerHumanId. A revoked agent claim
// doesn't retroactively un-own past surfaces, but those still need to be
// inaccessible to the new (unclaimed) state; the column is the source of
// truth. A surface whose ownerHumanId is null (legacy / unclaimed) cannot be
// opened through this path — the human has no claim on it.
async function loadOwnedSurface(
  prisma: PrismaClient,
  surfaceId: string,
  humanId: string,
) {
  const surface = await prisma.surface.findUnique({
    where: { id: surfaceId },
    include: { templateVersion: true },
  });
  if (!surface) throw errors.notFound();
  if (surface.ownerHumanId !== humanId) {
    // Same error oracle as a missing row — don't tell the caller that the
    // surface exists but belongs to someone else.
    throw errors.notFound();
  }
  return surface;
}

// Lazy-mint (or reuse) the owner's identity-bound participant. The raw token
// is generated only because Participant.tokenHash is `@unique` and required;
// it is NEVER returned to the caller and never persisted in any form besides
// the SHA-256 hash, so the row is reachable only via cookie-authed surface-id
// routes — never via /s/<token>.
async function getOrCreateOwnerParticipant(
  prisma: PrismaClient,
  surfaceId: string,
  humanId: string,
): Promise<{ identityId: string; id: string }> {
  const existing = await prisma.participant.findFirst({
    where: { surfaceId, humanId, kind: "human", revokedAt: null },
    select: { id: true, identityId: true },
  });
  if (existing) return existing;

  // Mirror the monotonic identity-id allocator from POST
  // /v1/surfaces/:id/participants in routes/surfaces.ts: derive the next index
  // from the ever-minted human count (including revoked rows so a revoke
  // doesn't recycle labels), and retry on P2002 unique-constraint collisions
  // against (surfaceId, identityId) caused by concurrent mints.
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const everMintedHumans = await prisma.participant.count({
      where: { surfaceId, kind: "human" },
    });
    const tok = generateHumanParticipantToken();
    try {
      const created = await prisma.participant.create({
        data: {
          surfaceId,
          kind: "human",
          identityId: `h_${everMintedHumans}`,
          tokenHash: hashKey(tok),
          tokenPrefix: keyPrefix(tok),
          humanId,
        },
        select: { id: true, identityId: true },
      });
      return created;
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== "P2002" || attempt === MAX_ATTEMPTS - 1) throw e;
      // A concurrent mint won this identity-id slot. The next loop iteration's
      // count() will pick it up; no backoff needed.
    }
  }
  // Reached only if `MAX_ATTEMPTS` consecutive concurrent mints stole the
  // identity-id slot — extremely unlikely under realistic concurrency, but
  // we surface a generic 500 rather than loop forever.
  throw new Error("could not allocate owner participant identity-id");
}

// GET /surfaces/:id — shell HTML for the owner.
ownerShell.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const human = c.get("human");
  const id = c.req.param("id");
  const surface = await loadOwnedSurface(prisma, id, human.id);

  const { agentLive, agentLastEventAt, agentLastUsedAt } =
    await computeAgentPresence(prisma, surface);
  const isClosed =
    surface.status !== "open" || surface.expiresAt.getTime() < Date.now();

  // Same wsUrl construction as the capability-token mount. WS auth itself
  // happens via a single-use ticket the shell mints right before connecting
  // (see POST /surfaces/:id/ws-ticket below) — the cookie never travels in a
  // WebSocket query string.
  const wsBase = config.publicUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
  const wsUrl = wsBase.replace(/\/$/, "") + `/v1/surfaces/${surface.id}/stream`;

  const schema = surface.templateVersion.eventSchema as unknown as EventSchema;
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

  const idSeg = `/surfaces/${encodeURIComponent(surface.id)}`;
  return c.body(
    renderShell({
      nonce,
      surfaceId: surface.id,
      iframeContentUrl: `${idSeg}/content`,
      presenceUrl: `${idSeg}/presence`,
      wsTicketUrl: `${idSeg}/ws-ticket`,
      // Session mode: pane_login cookie does the auth — no Authorization header.
      wsTicketAuthorization: null,
      attachmentsUploadUrl: `${idSeg}/attachments`,
      attachmentsDownloadUrlBase: `${idSeg}/attachments`,
      schema,
      inputData: surface.inputData ?? null,
      wsUrl,
      isClosed,
      agentLive,
      agentLastEventAt,
      agentLastUsedAt,
      title: surface.title,
    }),
  );
});

// GET /surfaces/:id/content — iframe template body (cookie-authed mirror of
// GET /s/:token/content).
ownerShell.get("/:id/content", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  const surface = await loadOwnedSurface(prisma, id, human.id);

  // Same closed-surface gate as the capability mount. The shell page already
  // renders a "closed" banner when isClosed, but a client that bookmarked
  // /content directly would otherwise still receive the template until the
  // surface was deleted.
  if (surface.status !== "open" || surface.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  let artifactBody: string;
  if (surface.templateVersion.templateType === "html-inline") {
    artifactBody = surface.templateVersion.templateSource;
  } else {
    // html-ref is rejected at POST /v1/surfaces — kept here as defence-in-depth.
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
<script>${SHIM_JS}</script>
</head>
<body>
${artifactBody}
</body>
</html>`;
  return c.body(wrapped);
});

// GET /surfaces/:id/presence — agent-presence poll (cookie-authed mirror of
// GET /s/:token/presence). Same computeAgentPresence so the two endpoints
// can never diverge on what "active" means.
ownerShell.get("/:id/presence", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  const surface = await loadOwnedSurface(prisma, id, human.id);

  const presence = await computeAgentPresence(prisma, surface);

  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(JSON.stringify(presence));
});

// POST /surfaces/:id/ws-ticket — short-lived single-use WebSocket upgrade
// ticket bound to the owner's identity. Lazy-mints the owner's Participant
// row on first use so the WS handler's joinedAt update + the events.authorId
// log have a stable identity-id for this owner.
ownerShell.post("/:id/ws-ticket", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  const surface = await loadOwnedSurface(prisma, id, human.id);

  if (surface.status !== "open" || surface.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  const participant = await getOrCreateOwnerParticipant(
    prisma,
    surface.id,
    human.id,
  );
  const author: Author = { kind: "human", id: participant.identityId };
  const ticket = issueTicket(author, surface.id);
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
// can be cleanly invoked with a session-resolved surface; that extraction is the
// next change on this branch. Templates that try to upload/download attachments
// from /surfaces/:id will hit a 404 from this mount and can fall back to the
// share-link URL until the follow-up commit lands. The shell config's
// `attachmentsUploadUrl` / `attachmentsDownloadUrlBase` still point at the
// id-keyed paths so no client-side change is needed when the routes appear.

export default ownerShell;
