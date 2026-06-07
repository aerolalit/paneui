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
//   2. accessMode === "public" → allow EMIT-CAPABLE for anyone (anon OK). The
//        product decision: a public pane is "view + participate" — an
//        anonymous visitor can both read AND submit. Anonymous emits are
//        stamped with a shared per-pane guest identity (PUBLIC_IDENTITY_ID)
//        and rate-limited (see ws/handler.ts) since they are an abuse surface.
//   3. accessMode === "link"   → allow READ-ONLY for anyone (anon OK). Anyone
//        with the URL can view but not emit; emit needs a token/grant. Diverges
//        from "public" both at this resolver (read-only vs participate) and at
//        the future discovery surface (a "public" pane may be listed; "link"
//        never is).
//   4. accessMode === "invite_only" (the gated path):
//        a. NOT logged in                          → login redirect (prompt
//             first, for ANY pane id, so the prompt is identical whether or
//             not the pane exists — no existence oracle)
//        b. logged-in human is owner OR has a grant → allow(owner|grant role)
//        c. logged-in, no grant                    → 404 (no oracle; never 403)
//
// On any allow, a logged-in human's open is recorded for Recents (best-
// effort). EVERY allowed viewer is handed a WS ticket so they can RECEIVE the
// event/record replay + live updates — but the ticket's `canEmit` flag gates
// emit: emit-capable for public visitors, owners, and participant grants;
// receive-only for link-mode anon and `viewer`-grants.

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
  getOrCreatePublicGuestParticipant,
  granteeIdentityId,
  OWNER_IDENTITY_ID,
} from "./identity-participant.js";
import { issueTicket, TICKET_TTL_MS } from "../../ws/ticket.js";
import type { Author } from "../../types.js";
import type { AppEnv } from "../env.js";

const paneAccess = new Hono<AppEnv>();

// The resolved access decision for a /p/:paneId request.
type Access =
  // Serve the pane. `canEmit` is the emit capability stamped onto the WS
  // ticket: a `participant`/owner grant and an anonymous PUBLIC visitor are
  // emit-capable; a `viewer` grant and a link-mode anon visitor are
  // receive-only. `humanId` is the logged-in human (null for anon). `isPublic`
  // marks an anonymous-allowed public open, so the ws-ticket route knows to
  // bind an anonymous emit to the shared public-guest identity.
  | {
      kind: "allow";
      role: "participant" | "viewer";
      humanId: string | null;
      canEmit: boolean;
      isPublic: boolean;
    }
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

  // (2) "public" opens to anyone, including an anonymous caller, and is
  // EMIT-CAPABLE — a public pane is "view + participate" per the product
  // decision. Checked before login state so the pane opens immediately. A
  // logged-in visitor emits under their own identity; an anonymous visitor
  // emits under the shared per-pane guest identity (the ws-ticket route binds
  // it). `role: "participant"` so the recents/emit-capability logic treats it
  // as a contributor.
  if (paneExists && pane!.accessMode === "public") {
    return {
      kind: "allow",
      role: "participant",
      humanId: human?.id ?? null,
      canEmit: true,
      isPublic: true,
    };
  }

  // (3) "link" opens READ-ONLY to anyone, including an anonymous caller — no
  // login prompt, but no emit either. Anyone with the URL can view; emitting
  // still requires a token or a participant grant. Any unrecognised stored
  // value falls through to the gated (invite_only) branch below — fail closed.
  if (paneExists && pane!.accessMode === "link") {
    return {
      kind: "allow",
      role: "viewer",
      humanId: human?.id ?? null,
      canEmit: false,
      isPublic: false,
    };
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
    return {
      kind: "allow",
      role: "participant",
      humanId: human.id,
      canEmit: true,
      isPublic: false,
    };
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
    return {
      kind: "allow",
      role,
      humanId: human.id,
      // A participant grant emits; a viewer grant is receive-only.
      canEmit: role === "participant",
      isPublic: false,
    };
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

// POST /p/:paneId/ws-ticket — WS upgrade ticket for ANY allowed viewer.
//
// The WS connection is needed for BOTH receiving (event/record replay + live
// updates) AND emitting, so EVERY allowed viewer is handed a ticket — otherwise
// a read-only viewer can never open the socket and the page loops "reconnecting"
// with no content (the bug this fixes). The ticket's `canEmit` flag carries the
// trust boundary the old 403 used to enforce: emit-capable for owners,
// participant grants, and public-pane visitors (anonymous included); receive-
// only for link-mode anon and `viewer`-grants. The WS handler rejects an emit
// frame from a receive-only connection (see ws/handler.ts), so a read-only
// viewer still RECEIVES but cannot WRITE.
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

  // Resolve the author the connection writes/joins as, and the ticket's emit
  // capability:
  //  - logged-in human → their identity slot (owner slot, or per-human grant
  //    slot). Used for both emit-capable and receive-only logged-in viewers so
  //    presence/joined events carry a coherent identity.
  //  - anonymous public visitor → the shared per-pane guest identity. Only the
  //    `public` mode reaches here anonymously with canEmit:true; link-mode anon
  //    is canEmit:false but still needs an author for its receive-only socket,
  //    so it shares the same guest slot (it just can't write).
  let author: Author;
  if (access.humanId) {
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
    author = { kind: "human", id: participant.identityId };
  } else {
    // Anonymous viewer (public participate, or link-mode read-only). Bind to
    // the shared guest identity so an anonymous public emit has an author the
    // event writer accepts, and a read-only anon socket still has a stable
    // author for its join/leave presence events.
    const guest = await getOrCreatePublicGuestParticipant(prisma, pane!.id);
    author = { kind: "human", id: guest.identityId };
  }

  const ticket = issueTicket(author, pane!.id, { canEmit: access.canEmit });
  return c.json(
    {
      ticket,
      expires_at: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    },
    201,
  );
});

export default paneAccess;
