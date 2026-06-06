// /p/:paneId — the identity-share mount. The pane-id-keyed URL a human lands
// on after an invite (or a public-share link, or an expired /s/:token that
// 302'd here). Resolves access from the login cookie + the pane's visibility
// state, then serves the SAME shell + iframe content the /s/:token and
// /panes/:id mounts serve (via src/bridge/serve-pane.ts) — only the auth
// differs.
//
//   GET /p/:paneId            shell HTML
//   GET /p/:paneId/content    iframe template body
//   GET /p/:paneId/presence   agent-presence poll
//   POST /p/:paneId/ws-ticket short-lived WS upgrade ticket (emit-capable
//                             callers only: owner + participant-role grant)
//
// Resolver order (mirrors the approved three-mode design):
//   1. valid participant token for this pane → allow(token role)
//        — N/A on this cookie mount (no token in the URL); the /s/:token
//          mount owns the token path. Kept here as a comment so the ordering
//          maps 1:1 to the design. CRITICAL: accessMode NEVER gates the token
//          path — a token works in every mode until explicitly revoked.
//   2. accessMode === "public" → allow(viewer, READ-ONLY) for anyone (anon OK)
//   3. accessMode === "link"   → allow(viewer, READ-ONLY) for anyone (anon OK).
//        Functionally identical to "public" at this resolver; the only
//        eventual difference is discovery/listing (a SEPARATE follow-up — a
//        "public" pane may be listed, a "link" pane never is).
//   4. accessMode === "invite_only" (the gated path):
//        a. NOT logged in                          → login redirect (prompt
//             first, for ANY pane id, so the prompt is identical whether or
//             not the pane exists — no existence oracle)
//        b. logged-in human is owner OR has a grant → allow(owner|grant role)
//        c. logged-in, no grant                    → 404 (no oracle; never 403)
//
// On any allow, a logged-in human's open is recorded for Recents (best-
// effort). Anonymous (link/public) and `viewer`-grant access are READ-ONLY:
// the ws-ticket route refuses them, and they never receive a participant
// token, so the page can never emit an event. Emit needs a participant token
// or a `participant`-role grant (owner included).

import { Hono, type Context } from "hono";
import type { PrismaClient } from "@prisma/client";
import type { Human as HumanRow } from "@prisma/client";
import { errors } from "../errors.js";
import { prefersHtml } from "../accept.js";
import { log } from "../../log.js";
import {
  servePaneShell,
  renderPaneContent,
  type ServeablePane,
} from "../../bridge/serve-pane.js";
import { recordView } from "../../bridge/recents.js";
import { computeAgentPresence } from "../../bridge/routes.js";
import {
  getOrCreateIdentityParticipant,
  granteeIdentityId,
  OWNER_IDENTITY_ID,
} from "./identity-participant.js";
import { issueTicket, TICKET_TTL_MS } from "../../ws/ticket.js";
import type { Author } from "../../types.js";
import type { AppEnv } from "../env.js";

const paneAccess = new Hono<AppEnv>();

// The resolved access decision for a /p/:paneId request.
type Access =
  // Serve the pane. `role` gates emit: "participant" (owner or participant
  // grant) can mint a ws-ticket; "viewer" (public-anon or viewer grant) is
  // read-only. `humanId` is the logged-in human (null for public-anon).
  | { kind: "allow"; role: "participant" | "viewer"; humanId: string | null }
  // Bounce to /login carrying the return URL (not-logged-in, invite_only pane).
  | { kind: "login" }
  // Indistinguishable from "pane does not exist" — no existence oracle.
  | { kind: "not_found" };

// Resolve the login cookie to a Human, or null. Inlined (not resolveHuman-
// Optional) because we branch on present-vs-missing and need the human row.
async function resolveHumanFromCookie(
  c: Context<AppEnv>,
): Promise<HumanRow | null> {
  const prisma = c.get("prisma");
  const { parseLoginCookie, hashLoginCookie } =
    await import("../../auth/cookie.js");
  const cookieValue = parseLoginCookie(c.req.header("cookie") ?? null);
  if (!cookieValue) return null;
  const login = await prisma.login.findUnique({
    where: { cookieHash: hashLoginCookie(cookieValue) },
    include: { human: true },
  });
  if (!login || login.expiresAt < new Date()) return null;
  return login.human;
}

// The pane fields the resolver + serving path need. Loaded once per request.
type LoadedPane = ServeablePane & {
  ownerHumanId: string | null;
  accessMode: string;
  deletedAt: Date | null;
};

async function loadPane(
  prisma: PrismaClient,
  paneId: string,
): Promise<LoadedPane | null> {
  const pane = await prisma.pane.findUnique({
    where: { id: paneId },
    include: { templateVersion: true },
  });
  if (!pane) return null;
  return pane as unknown as LoadedPane;
}

// The whole access decision. Order matches the design comment above.
async function resolveAccess(
  prisma: PrismaClient,
  pane: LoadedPane | null,
  human: HumanRow | null,
): Promise<Access> {
  // A soft-deleted pane is treated as not-found for share access (the /trash
  // UI is the only place a trashed pane is viewable). For an anonymous caller
  // we collapse this into the same login/not-found shape below so it stays
  // oracle-free.
  const paneExists = pane !== null && pane.deletedAt === null;

  // (2)+(3) "public" and "link" both open READ-ONLY to anyone, including an
  // anonymous caller — no login prompt. Checked before login state so the pane
  // opens immediately. The two modes are identical here; they diverge only at
  // the (future) discovery surface, which is out of scope for this resolver.
  // Any unrecognised stored value falls through to the gated (invite_only)
  // branch — fail closed.
  if (
    paneExists &&
    (pane!.accessMode === "public" || pane!.accessMode === "link")
  ) {
    return { kind: "allow", role: "viewer", humanId: human?.id ?? null };
  }

  // (4) invite_only (and any unknown mode, fail-closed). Not logged in → prompt
  // to log in. Done for ANY pane id (existing or not) so the prompt can't be
  // used to probe pane existence.
  if (!human) {
    return { kind: "login" };
  }

  // From here the caller is a logged-in human on an invite_only pane.
  if (!paneExists) {
    // Logged in but the pane is gone/trashed → 404 (same as "no grant").
    return { kind: "not_found" };
  }

  // (4) owner → full participant role. The owner has no PaneGrant row; their
  // ownership IS the grant. (The /panes/:id mount is the owner's primary
  // entry point, but /p/:paneId must work for them too — e.g. an expired
  // /s/:token they themselves hold redirects here.)
  if (pane!.ownerHumanId === human.id) {
    return { kind: "allow", role: "participant", humanId: human.id };
  }

  // (4) grantee → grant role. Only a bound grant (humanId set on login)
  // counts; a still-pending invite (inviteEmail only) does not grant access
  // until the invitee logs in and the magic-link verify binds it.
  const grant = await prisma.paneGrant.findUnique({
    where: { paneId_humanId: { paneId: pane!.id, humanId: human.id } },
    select: { role: true },
  });
  if (grant) {
    const role = grant.role === "viewer" ? "viewer" : "participant";
    return { kind: "allow", role, humanId: human.id };
  }

  // (5) logged in, no grant → 404. NEVER 403 — a 403 would confirm the pane
  // exists. Indistinguishable from a non-existent pane.
  return { kind: "not_found" };
}

// Bounce an HTML navigation to /login carrying the return URL; emit the
// generic 404 envelope for API/curl callers. The login bounce is also the
// "not_found for anonymous" path so a logged-out probe can't tell an
// existing private pane from a missing one.
function bounceToLogin(c: Context<AppEnv>): Response {
  const u = new URL(c.req.url);
  const returnTo = u.pathname + u.search;
  return c.redirect(`/login?return=${encodeURIComponent(returnTo)}`, 302);
}

// Render the error/login outcome for a non-allow decision on a GET shell/
// content request. Login → 302 for browsers, 401-ish JSON for API. Not-found
// → 404 (HTML page for browsers via the shared error renderer, JSON for API).
function denyResponse(c: Context<AppEnv>, access: Access): Response {
  if (access.kind === "login") {
    if (prefersHtml(c.req.header("Accept"))) return bounceToLogin(c);
    // API caller hitting a private pane while logged out — generic 404, same
    // as a logged-in non-grantee, so neither path is an existence oracle.
    throw errors.notFound();
  }
  // not_found
  throw errors.notFound();
}

// GET /p/:paneId — shell HTML.
paneAccess.get("/:paneId", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const paneId = c.req.param("paneId");
  if (!paneId) throw errors.notFound();

  const human = await resolveHumanFromCookie(c);
  const pane = await loadPane(prisma, paneId);
  const access = await resolveAccess(prisma, pane, human);
  if (access.kind !== "allow") return denyResponse(c, access);

  // Recents: record a logged-in human's open (best-effort, fire-and-forget).
  if (access.humanId) {
    const hid = access.humanId;
    recordView(prisma, hid, pane!.id).catch((err: unknown) =>
      log.warn("recordView failed (pane-access)", {
        paneId: pane!.id,
        humanId: hid,
        error: String(err),
      }),
    );
  }

  const seg = `/p/${encodeURIComponent(pane!.id)}`;
  return servePaneShell(c, prisma, config, pane!, {
    basePath: seg,
    // Session/public mode: the ws-ticket POST is cookie-authed (or refused for
    // read-only callers) — no Authorization header.
    wsTicketUrl: `${seg}/ws-ticket`,
    wsTicketAuthorization: null,
    // Slim account bar only when a human is logged in.
    topNav: human ? { email: human.email } : null,
  });
});

// GET /p/:paneId/content — iframe template body.
paneAccess.get("/:paneId/content", async (c) => {
  const prisma = c.get("prisma");
  const paneId = c.req.param("paneId");
  if (!paneId) throw errors.notFound();

  const human = await resolveHumanFromCookie(c);
  const pane = await loadPane(prisma, paneId);
  const access = await resolveAccess(prisma, pane, human);
  if (access.kind !== "allow") return denyResponse(c, access);

  // Closed-pane gate — same as the other mounts. The shell shows a banner;
  // bookmarking /content directly would otherwise still leak the template.
  if (pane!.status !== "open" || pane!.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  return renderPaneContent(c, pane!);
});

// GET /p/:paneId/presence — agent-presence poll.
paneAccess.get("/:paneId/presence", async (c) => {
  const prisma = c.get("prisma");
  const paneId = c.req.param("paneId");
  if (!paneId) throw errors.notFound();

  const human = await resolveHumanFromCookie(c);
  const pane = await loadPane(prisma, paneId);
  const access = await resolveAccess(prisma, pane, human);
  if (access.kind !== "allow") return denyResponse(c, access);

  const presence = await computeAgentPresence(prisma, pane!);
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(JSON.stringify(presence));
});

// POST /p/:paneId/ws-ticket — emit-capable WS upgrade ticket.
//
// READ-ONLY enforcement lives here: only an "allow(participant)" decision
// (owner or participant-role grant) mints a ticket. A viewer grant, a public-
// anonymous open, or a logged-out caller is refused — the page can poll +
// render but never emit. This is the same trust boundary the /s/:token mint
// relies on (a token's Participant row carries the emit capability).
paneAccess.post("/:paneId/ws-ticket", async (c) => {
  const prisma = c.get("prisma");
  const paneId = c.req.param("paneId");
  if (!paneId) throw errors.notFound();

  const human = await resolveHumanFromCookie(c);
  const pane = await loadPane(prisma, paneId);
  const access = await resolveAccess(prisma, pane, human);

  // Non-allow → same shapes as the GET routes, but POST never redirects:
  // a logged-out XHR gets the generic 404 (no oracle), a logged-in non-
  // grantee gets 404.
  if (access.kind !== "allow") {
    throw errors.notFound();
  }

  if (pane!.status !== "open" || pane!.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  // Read-only callers cannot emit. A viewer grant / public-anon / a caller
  // with no resolved human all land here. 403 is correct: the resource exists
  // and is being served read-only to this caller; it's the *emit* action that
  // is refused, which is not an existence oracle (they can already see the
  // pane).
  if (access.role !== "participant" || !access.humanId) {
    throw errors.forbidden(
      "read_only",
      "this pane is read-only for you; emitting page events requires participant access",
    );
  }

  // Owner uses the reserved owner identity slot; a participant grantee uses a
  // per-human grant slot. Both go through the shared lazy-mint so the audit
  // log stays coherent and the (paneId, identityId) constraint dedups.
  const identityId =
    pane!.ownerHumanId === access.humanId
      ? OWNER_IDENTITY_ID
      : granteeIdentityId(access.humanId);
  const participant = await getOrCreateIdentityParticipant(
    prisma,
    pane!.id,
    access.humanId,
    identityId,
  );
  const author: Author = { kind: "human", id: participant.identityId };
  const ticket = issueTicket(author, pane!.id);
  return c.json(
    {
      ticket,
      expires_at: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    },
    201,
  );
});

export default paneAccess;
