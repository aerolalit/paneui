import { Hono, type Context } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import { BRAND_FAVICON_DATA_HREF, BRAND_MARK_SVG_BODY } from "../brand.js";
import { hashKey } from "../keys.js";
import type { AppEnv } from "../http/env.js";
import { errors, ApiError } from "../http/errors.js";
import { prefersHtml } from "../http/accept.js";
import { participantBindingSatisfied } from "../auth/human-auth.js";
import { agentCount } from "../ws/presence.js";
import type { EventSchema } from "../types.js";
import { PANE_DEFAULT_CSS, shouldInjectDefaults } from "./default-styles.js";
import { buildPaneCsp, paneCspImgOrigin } from "./preview-render.js";
import { paneAppleTouchIcon } from "../http/routes/apple-touch-icon.js";
import { recordView } from "./recents.js";
import { log } from "../log.js";

const bridge = new Hono<AppEnv>();

// Compiled client bundles. Authored as real TS modules under
// src/bridge/client/*.ts and compiled by `tsc -p tsconfig.client.json` (which
// the `pre*` npm hooks run before dev/test/typecheck). Output lives at
// dist/client/*.js regardless of whether we're running tsx-from-source or
// node-from-dist, so we resolve a single absolute path from the project root.
const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export function loadClient(name: string): string {
  const path = resolve(PROJECT_ROOT, "dist", "client", name);
  let js: string;
  try {
    js = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `pane relay: client bundle missing at ${path} — run \`npm run build:client\` first`,
    );
  }
  // The client TS files are modules (`export {}` for file scoping + the
  // runtime's `declare global`), but they're injected inline as a classic
  // <script>, where
  // any `import`/`export` is a SyntaxError that aborts the whole script. Each
  // file is self-contained (IIFE-wrapped), so the module markers carry no
  // runtime meaning — strip the `export {};` tsc emits.
  js = js.replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, "");
  // The result is embedded as `<script>${js}</script>`. A literal `</script>`
  // anywhere in the file (e.g. in a comment) would close the tag early and dump
  // the remainder as page text. `<\/script>` is identical JS — the `\` is an
  // ignored escape — but the HTML parser no longer sees a tag close.
  return js.replace(/<\/(script)/gi, "<\\/$1");
}
const RUNTIME_JS = loadClient("runtime.client.js");
const SHELL_JS = loadClient("shell.client.js");
// The runtime is exported so the owner-shell `/panes/:id/content` route can
// inline the same iframe runtime as the capability-token `/s/:token/content`
// route — both serve the same template body under the same CSP.
export { RUNTIME_JS, PERMISSIONS_POLICY };

function publicWsBase(config: Config): string {
  const u = new URL(config.publicUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/$/, "");
}

// The Pane brand mark as a data URI for the browser tab. Inlined (vs.
// /favicon.ico) avoids an extra HTTP round-trip on every page load.
// Both the shell CSP and the error-page CSP allow `data:` in img-src.
// Sourced from src/brand.ts so the system-pages header, /favicon.svg
// endpoint, and this data URI cannot drift.
const BRAND_FAVICON_HREF = BRAND_FAVICON_DATA_HREF;

// Belt-and-braces alongside the iframe sandbox. Disables every powerful API the
// browser exposes by default. Listed explicitly rather than `*=()` because the
// `Permissions-Policy` header has no "deny-all" shorthand.
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  // `ambient-light-sensor` was removed from the spec; modern Chromium logs
  // "Unrecognized feature" if we list it. Dropped.
  "autoplay=()",
  // `battery` was likewise removed from the spec (the Battery Status API
  // was deprecated; the directive name was retired). Dropped.
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

// Participant tokens are minted in keys.ts as a type prefix ("tok_a_" for
// agent, "tok_h_" for human) followed by `randomBytes(32).toString("base64url")`
// — 6 prefix chars + 43 base64url chars = 49 chars total. Reject on shape
// before we hash so pathological inputs (10 MB strings, control chars) can't
// force SHA-256 work and a guaranteed-miss DB lookup. A real rate limiter
// belongs at the edge (tracked in issue #6); this is the in-app first line of
// defence.
const TOKEN_RX = /^tok_[ah]_[A-Za-z0-9_-]{43}$/;

// loadByToken resolves a /s/:token participant + pane and — by default —
// ENFORCES the identity binding (F-02): if the participant is bound to a
// human (`humanId` set), the request must carry a matching `pane_login`
// cookie, else it 404s opaquely (same shape as a bad/revoked token, so the
// bridge isn't an "account exists" oracle).
//
// `opts.cookieHeader` MUST be threaded in by every caller (the raw `Cookie:`
// header) so the binding can be checked. The one exception is the shell page
// handler, which passes `enforceBinding: false` because it implements a
// RICHER UX for the same condition (302 → /login when logged out, 403
// wrong_account when logged in as someone else) and so does its own check.
async function loadByToken(
  prisma: PrismaClient,
  token: string,
  opts: { cookieHeader?: string | null; enforceBinding?: boolean } = {},
) {
  const { cookieHeader = null, enforceBinding = true } = opts;
  if (!TOKEN_RX.test(token)) throw errors.notFound();
  const participant = await prisma.participant.findUnique({
    where: { tokenHash: hashKey(token) },
  });
  if (!participant || participant.revokedAt) throw errors.notFound();
  if (enforceBinding) {
    const ok = await participantBindingSatisfied(
      prisma,
      participant,
      cookieHeader,
    );
    // Opaque 404 — identical to an unknown/revoked token so a holder of a
    // leaked identity-bound token can't distinguish "needs the bound login"
    // from "token is dead". The shell page (enforceBinding:false) is the
    // human-facing surface that turns this into a login redirect / 403.
    if (!ok) throw errors.notFound();
  }
  const pane = await prisma.pane.findUnique({
    where: { id: participant.paneId },
    include: { templateVersion: true },
  });
  if (!pane) throw errors.notFound();
  return { participant, pane };
}

// Recover the paneId a token points at even when the participant is REVOKED
// (but the row still exists). Used by the /s/:token shell handler to upgrade
// an expired/revoked share link into a 302 → /p/:paneId, where the identity-
// share resolver re-evaluates access (public? grant? login?) instead of a
// dead-end 404. Returns null when the token is malformed, fully purged, or
// the pane row is gone — in those cases the caller falls back to the generic
// 404/login path (no crash, no oracle).
async function recoverPaneIdFromToken(
  prisma: PrismaClient,
  token: string,
): Promise<string | null> {
  if (!TOKEN_RX.test(token)) return null;
  const participant = await prisma.participant.findUnique({
    where: { tokenHash: hashKey(token) },
    select: { paneId: true },
  });
  if (!participant) return null;
  const pane = await prisma.pane.findUnique({
    where: { id: participant.paneId },
    select: { id: true },
  });
  return pane?.id ?? null;
}

// Resolve a logged-in human from the request cookie and record a pane view for
// Recents. Best-effort: any failure (no cookie, expired login, DB hiccup) is
// swallowed — recording a view must never affect serving the pane. Anonymous
// opens (no/invalid cookie) record nothing.
async function recordTokenOpenerView(
  prisma: PrismaClient,
  cookieHeader: string | null,
  paneId: string,
): Promise<void> {
  try {
    const { parseLoginCookie, hashLoginCookie } =
      await import("../auth/cookie.js");
    const cookieValue = parseLoginCookie(cookieHeader);
    if (!cookieValue) return;
    const login = await prisma.login.findUnique({
      where: { cookieHash: hashLoginCookie(cookieValue) },
      select: { humanId: true, expiresAt: true },
    });
    if (!login || login.expiresAt < new Date()) return;
    await recordView(prisma, login.humanId, paneId);
  } catch (err) {
    log.warn("recordView failed (token opener)", {
      paneId,
      error: String(err),
    });
  }
}

// The shell shows an "agent presence" pill. Presence is LIVE runtime state,
// so it is computed from three present-tense signals — NOT by replaying the
// persisted `system.participant.*` log (a `left` event can be lost, which
// would leave a stale `joined` claiming an agent is connected forever):
//  1) agentLive        — an agent WebSocket is open on this pane right now.
//  2) agentLastEventAt — the most recent agent-authored Event's timestamp.
//  3) agentLastUsedAt  — the owning agent's last authenticated request.
// Shared by the `/:token` route (seeds the shell config once) and the
// `/:token/presence` route (the shell polls this to keep the pill fresh) so
// the two never diverge.
export interface AgentPresence {
  agentLive: boolean;
  agentLastEventAt: string | null;
  agentLastUsedAt: string | null;
}

export async function computeAgentPresence(
  prisma: PrismaClient,
  pane: {
    id: string;
    agentId: string;
  },
): Promise<AgentPresence> {
  const agent = await prisma.agent.findUnique({
    where: { id: pane.agentId },
    select: { lastUsedAt: true },
  });
  const agentLastUsedAt = agent?.lastUsedAt
    ? agent.lastUsedAt.toISOString()
    : null;

  const lastAgentEvent = await prisma.event.findFirst({
    where: { paneId: pane.id, authorKind: "agent" },
    orderBy: { ts: "desc" },
    select: { ts: true },
  });
  const agentLastEventAt = lastAgentEvent
    ? lastAgentEvent.ts.toISOString()
    : null;

  const agentLive = (await agentCount(pane.id)) > 0;

  return { agentLive, agentLastEventAt, agentLastUsedAt };
}

bridge.get("/:token", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const token = c.req.param("token");
  if (!token) {
    return humanOrJsonError(c, errors.notFound());
  }
  let loaded: Awaited<ReturnType<typeof loadByToken>>;
  try {
    // enforceBinding:false — this handler implements the richer human-facing
    // UX for the identity binding below (302 → /login, 403 wrong_account)
    // instead of the opaque 404 loadByToken would otherwise raise.
    loaded = await loadByToken(prisma, token, { enforceBinding: false });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      // Expired/revoked token: instead of a dead-end 404, try to recover the
      // pane id the (now-dead) token pointed at and 302 → /p/:paneId, where
      // the identity-share resolver re-evaluates access (public? grant?
      // login?). Falls back to the generic 404/login page when the token is
      // fully unrecoverable (malformed, purged, pane gone) — no crash, no
      // existence oracle. Only redirect HTML navigations; API/curl callers
      // keep the JSON envelope they branch on.
      if (prefersHtml(c.req.header("Accept"))) {
        const paneId = await recoverPaneIdFromToken(prisma, token);
        if (paneId) return c.redirect(`/p/${encodeURIComponent(paneId)}`, 302);
      }
      return humanOrJsonError(c, err);
    }
    throw err;
  }
  const { pane, participant } = loaded;

  // Recents: if the opener is a logged-in human, record the view. Best-effort
  // and fire-and-forget — never block the page. Anonymous opens record
  // nothing (no humanId resolved).
  void recordTokenOpenerView(prisma, c.req.header("cookie") ?? null, pane.id);

  // Logged-in owner → upgrade to the clean session-authed URL. If the
  // caller is signed in as the pane's owner, redirect them off the
  // capability-token URL onto /panes/:id, where the pane_login cookie
  // does the auth and the URL bar shows nothing sensitive. This makes the
  // share link a graceful one-way ramp for the owner: they paste a /s/<tok>
  // URL once (e.g. from an email they sent themselves), and from then on
  // the address bar reflects the pane-id route.
  //
  // Done BEFORE the identity-bound participant gate below: an owner whose
  // own agent created the pane generally won't be a participant on it,
  // so the gate below wouldn't apply — but we still want to upgrade them.
  // Done AFTER loadByToken so a bad/revoked token still 404s as before; we
  // never leak pane state by redirecting on an invalid token.
  if (pane.ownerHumanId) {
    const { parseLoginCookie, hashLoginCookie } =
      await import("../auth/cookie.js");
    const cookieValue = parseLoginCookie(c.req.header("cookie") ?? null);
    if (cookieValue) {
      const login = await prisma.login.findUnique({
        where: { cookieHash: hashLoginCookie(cookieValue) },
      });
      if (
        login &&
        login.expiresAt > new Date() &&
        login.humanId === pane.ownerHumanId
      ) {
        return c.redirect(`/panes/${pane.id}`, 302);
      }
    }
  }

  // Identity-bound participants (Phase E §7.3 A) require the caller to be
  // logged in as the bound human. Anonymous capability participants
  // (humanId null) pass through unchanged — that's the existing behaviour.
  if (participant.humanId) {
    const { parseLoginCookie, hashLoginCookie } =
      await import("../auth/cookie.js");
    const cookieValue = parseLoginCookie(c.req.header("cookie") ?? null);
    let loggedInHumanId: string | null = null;
    if (cookieValue) {
      const login = await prisma.login.findUnique({
        where: { cookieHash: hashLoginCookie(cookieValue) },
      });
      if (login && login.expiresAt > new Date()) {
        loggedInHumanId = login.humanId;
      }
    }
    if (loggedInHumanId === null) {
      // Not logged in — bounce to /login carrying the return URL so the
      // human lands back on this pane after magic-link verify.
      const returnUrl = encodeURIComponent(`/s/${token}`);
      return c.redirect(`/login?return=${returnUrl}`, 302);
    }
    if (loggedInHumanId !== participant.humanId) {
      // Logged in as someone else — 403 with a "switch account" hint.
      // Match the proposal §4.6 spec: "switch account" page; for now JSON.
      return c.json(
        {
          error: {
            code: "wrong_account",
            message:
              "this pane is invited to a different account; sign out and sign in as that human",
          },
        },
        403,
      );
    }
  }

  // Live agent-presence facts that SEED the shell's pill — see
  // computeAgentPresence. The shell then keeps them fresh by polling
  // /:token/presence (a polling agent never opens a WebSocket, so the seed
  // would otherwise go stale within ~30s).
  const { agentLive, agentLastEventAt, agentLastUsedAt } =
    await computeAgentPresence(prisma, pane);

  const isClosed =
    pane.status !== "open" || pane.expiresAt.getTime() < Date.now();
  const wsUrl = publicWsBase(config) + "/v1/panes/" + pane.id + "/stream";
  const schema = pane.templateVersion.eventSchema as unknown as EventSchema;
  // 16 bytes of entropy, base64url so the value is safe inside both CSP and
  // an HTML attribute without escaping.
  const nonceBuf = new Uint8Array(16);
  crypto.getRandomValues(nonceBuf);
  const nonce = Buffer.from(nonceBuf).toString("base64url");

  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // Nonce-only on script/style: dropping 'self' means another same-origin
      // endpoint that ever serves attacker-controlled content can't XSS the
      // shell. The shell has exactly one nonced <script> + one nonced <style>.
      // The JSON config block (<script type="application/json">) does not
      // execute — script-src does not apply to non-executable script types.
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
      // 'self' covers same-origin HTTP fetches but NOT the ws:/wss: scheme —
      // CSP treats a WebSocket as a distinct scheme and would block the shell's
      // connection to /v1/panes/:id/stream. Allow the relay's own ws origin.
      `connect-src 'self' ${publicWsBase(config)}`,
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

  // Capability-token mount: every callback URL embeds the participant token,
  // and the ws-ticket mint uses the token as Bearer auth. Mirror the legacy
  // shape exactly so existing /s/<token> sessions behave unchanged.
  const tokenSeg = `/s/${encodeURIComponent(token)}`;
  return c.body(
    renderShell({
      nonce,
      paneId: pane.id,
      iframeContentUrl: `${tokenSeg}/content`,
      presenceUrl: `${tokenSeg}/presence`,
      // ws-ticket mint stays under /v1 in token mode — that endpoint already
      // accepts both an agent key and a participant token as dual auth.
      wsTicketUrl: `/v1/panes/${encodeURIComponent(pane.id)}/ws-ticket`,
      wsTicketAuthorization: `Bearer ${token}`,
      attachmentsUploadUrl: `${tokenSeg}/attachments`,
      attachmentsDownloadUrlBase: `${tokenSeg}/attachments`,
      schema,
      inputData: pane.inputData ?? null,
      wsUrl,
      isClosed,
      agentLive,
      agentLastEventAt,
      agentLastUsedAt,
      title: pane.title,
      preamble: pane.preamble,
      // Capability-token mount: the caller is either anonymous or a
      // non-owner who reached this pane via a share link. They don't
      // have the system-pages context, so no top nav. (A logged-in OWNER
      // hitting /s/<token> is already 302'd to /panes/<id> above this
      // point, so they never see the bare token shell.)
      topNav: null,
      // This pane's own home-screen icon (effective image icon → robot).
      appleTouchIconHref: `${tokenSeg}/icon.png`,
    }),
  );
});

// GET /s/:token/icon.png — this pane's iOS home-screen (apple-touch) icon. The
// token in the URL is the auth: iOS fetches apple-touch-icon with no cookie, so
// a cookie-gated route would 401 and leave the shortcut with a screenshot. The
// resolver ALWAYS returns a 180×180 PNG (the pane's effective IMAGE icon
// composited on the brand tile, else the robot default), so the shortcut always
// gets a real icon.
bridge.get("/:token/icon.png", async (c) => {
  const prisma = c.get("prisma");
  const token = c.req.param("token");
  // loadByToken validates the token shape + resolves the pane (404 on a bad or
  // revoked token — a non-pane URL shouldn't yield an icon).
  //
  // enforceBinding:false — iOS fetches apple-touch-icon with NO cookie, so an
  // identity-bound token could never satisfy the cookie check here and the
  // shortcut would fall back to a screenshot. The icon route deliberately
  // returns only this pane's (or the default robot) 180×180 PNG — no event
  // data, no template body, no presence — so leaving it token-only does not
  // expose anything the binding is meant to protect.
  const { pane } = await loadByToken(prisma, token, { enforceBinding: false });

  // Effective icon, pane override → template fallback, for BOTH the image and
  // the emoji (the resolver prefers image, then emoji, then the robot — same
  // precedence as the in-app tile). loadByToken's pane row carries the pane's
  // own iconAttachmentId + iconEmoji; the template's live one join away, fetched
  // only when the pane leaves one of them unset.
  let effective = pane.iconAttachmentId;
  let effectiveEmoji = pane.iconEmoji;
  if (!effective || !effectiveEmoji) {
    const withTpl = await prisma.pane.findUnique({
      where: { id: pane.id },
      select: {
        templateVersion: {
          select: {
            template: {
              select: { iconAttachmentId: true, iconEmoji: true },
            },
          },
        },
      },
    });
    const tpl = withTpl?.templateVersion?.template;
    if (!effective) effective = tpl?.iconAttachmentId ?? null;
    if (!effectiveEmoji) effectiveEmoji = tpl?.iconEmoji ?? null;
  }

  const { png, etag } = await paneAppleTouchIcon(
    c.get("blobStore"),
    prisma,
    effective,
    effectiveEmoji,
    pane.id,
  );

  c.header("ETag", etag);
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", "public, max-age=3600");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);

  // Hono's c.body wants an ArrayBuffer, not a Buffer — hand it a tight slice.
  const ab = png.buffer.slice(
    png.byteOffset,
    png.byteOffset + png.byteLength,
  ) as ArrayBuffer;
  return c.body(ab);
});

bridge.get("/:token/content", async (c) => {
  const prisma = c.get("prisma");
  const token = c.req.param("token");
  if (!token) {
    return humanOrJsonError(c, errors.notFound());
  }
  let loaded: Awaited<ReturnType<typeof loadByToken>>;
  try {
    // Enforce the identity binding here (default): a leaked identity-bound
    // token must NOT be able to fetch the template body without the bound
    // login cookie. The iframe carries the cookie on this same-origin fetch.
    loaded = await loadByToken(prisma, token, {
      cookieHeader: c.req.header("cookie") ?? null,
    });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      return humanOrJsonError(c, err);
    }
    throw err;
  }
  const { pane } = loaded;

  // Gate the template body on the pane being live. The shell page renders
  // a "closed" banner instead of the iframe, but a client that bookmarked
  // /content directly would otherwise still receive the template (and any
  // sensitive data baked into it) until the participant is revoked.
  if (pane.status !== "open" || pane.expiresAt.getTime() < Date.now()) {
    return humanOrJsonError(c, errors.gone());
  }

  let artifactBody: string;
  if (pane.templateVersion.templateType === "html-inline") {
    artifactBody = pane.templateVersion.templateSource;
  } else {
    // html-ref is rejected at POST /v1/panes in this release, so no new
    // pane reaches here with that type. Kept as defence-in-depth for any
    // pre-existing row; fetch + cache support is deferred to a later phase.
    artifactBody = "<!-- template.type=html-ref is not implemented in v1 -->";
  }

  // Single source of truth for the iframe-content CSP (see buildPaneCsp in
  // preview-render.ts). `img-src`/`media-src` include the relay's own origin so
  // a template can render attachment bytes straight from a `/b/<token>`
  // capability URL; `data:` is retained for small inline bytes, and
  // `connect-src 'none'` keeps fetch/XHR blocked. 'unsafe-inline' (no nonce) is
  // required so the agent's own inline <script> tags inside artifactBody — and
  // the runtime — execute under the same sandbox.
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

  // Default stylesheet — injected in <head> before the agent's markup so any
  // author <style> blocks win the cascade at equal specificity. The literal
  // marker `data-pane-bare` anywhere in the artifact body skips injection
  // entirely for artifacts that want a blank canvas.
  const styleBlock = shouldInjectDefaults(artifactBody)
    ? `<style>${PANE_DEFAULT_CSS}</style>`
    : "";
  const wrapped = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${styleBlock}
<script>${RUNTIME_JS}</script>
</head>
<body>
${artifactBody}
</body>
</html>`;
  return c.body(wrapped);
});

// Lightweight presence endpoint. The shell polls this every ~10s so the
// agent-presence pill reflects a polling agent (one that monitors via
// `pane pane show` HTTP polls and never opens a WebSocket) — its `lastUsedAt`
// keeps advancing server-side but the page-load config seed cannot see it.
//
// Trust model: the URL token IS the auth, identical to the shell page
// (`/:token`) it accompanies. No extra credential is required. The body is a
// tiny JSON object and is cheap to recompute on every poll.
bridge.get("/:token/presence", async (c) => {
  const prisma = c.get("prisma");
  const token = c.req.param("token");
  if (!token) throw errors.notFound();
  // Enforce the identity binding (default) — the shell polls this with the
  // bound login cookie; a leaked token without it 404s like a dead token.
  const { pane } = await loadByToken(prisma, token, {
    cookieHeader: c.req.header("cookie") ?? null,
  });

  const presence = await computeAgentPresence(prisma, pane);

  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(JSON.stringify(presence));
});

export interface ShellArgs {
  nonce: string;
  paneId: string;
  // Path the iframe loads (e.g. `/s/<token>/content` or `/panes/<id>/content`).
  // Carried as a separate field so renderShell stays auth-mode-agnostic.
  iframeContentUrl: string;
  // Same-origin endpoints the shell calls back into. Carrying these in the
  // CFG (vs. constructing them in the client from a token) lets a single
  // shell bundle drive both the capability-token mount and the session-authed
  // mount; see ShellCfg in src/bridge/client/shell.client.ts.
  presenceUrl: string;
  wsTicketUrl: string;
  // Authorization header value sent on the ws-ticket POST. Null in session
  // mode (the pane_login cookie travels automatically); the participant
  // `Bearer <token>` in capability-token mode.
  wsTicketAuthorization: string | null;
  attachmentsUploadUrl: string;
  attachmentsDownloadUrlBase: string;
  schema: EventSchema;
  // The pane's per-instance input_data (validated against the template
  // version's input_schema at create time). Threaded through the shell config
  // and the init frame so the template can read it as `window.pane.inputData`.
  inputData: unknown;
  wsUrl: string;
  isClosed: boolean;
  // Live agent-presence facts, computed at request time. See the /s/:token
  // handler for what each signal means.
  agentLive: boolean;
  agentLastEventAt: string | null;
  agentLastUsedAt: string | null;
  // Agent-supplied (or Template.name-resolved) per-pane title. Validated at
  // pane create — non-empty, ≤80 chars, no control chars — but still
  // untrusted at this point; HTML-escaped into <title> at render time.
  title: string;
  // Optional agent-supplied context message. Validated at pane create
  // (≤280 chars, one `\n` allowed). Rendered into the shell band above the
  // iframe — HTML-escaped at render. Null when the agent didn't pass one.
  preamble: string | null;
  // Optional top-nav block — the slim account bar (brand + presence pills +
  // a Share button + sign out) rendered above the iframe for a logged-in pane
  // owner. No system-page tabs: a pane viewer is a focused, single-pane
  // surface, so it carries only "where am I / what's the relay doing / what
  // can I do here" chrome. The capability-token mount (/s/<token>) leaves this
  // null — anonymous callers and non-owner participants get no account bar at
  // all, so the Share affordance is inherently owner-only.
  //
  // `canShare` gates the Share button. It's true for an owner viewing their
  // own pane (the only caller that sets topNav today); modelled explicitly so
  // a future non-owner top-nav variant can opt out of sharing.
  topNav: { canShare: boolean } | null;
  // Href for the iOS home-screen icon (apple-touch-icon). The /s/<token> mount
  // points at this pane's own icon route (`/s/<token>/icon.png` — the pane's
  // effective image icon, else the robot default); the owner mount keeps the
  // static `/apple-touch-icon.png` (its icon route is cookie-gated and iOS may
  // fetch the icon without the cookie).
  appleTouchIconHref: string;
}

function renderTopNav(args: ShellArgs): string {
  if (!args.topNav) return "";
  const { canShare } = args.topNav;
  // Presence pills live in the SAME bar as the brand + account — one row for
  // "where am I" (brand) and "what is the relay doing" (presence) beside the
  // account actions, so the eye picks up both states without scanning
  // vertically.
  const closedLabel = args.isClosed ? "pane closed" : "no agent yet";
  // Share button — owner-only by construction (topNav is non-null only on the
  // owner mount). Opens the in-page share dialog (see renderShareModal +
  // shareModalScript). Icon + label so it reads at a glance on desktop;
  // the label collapses on narrow viewports via .top-nav-share .label.
  const shareBtn = canShare
    ? `<button id="top-nav-share" class="top-nav-share" type="button" aria-haspopup="dialog" aria-label="Share this pane">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        <span class="label">Share</span>
      </button>`
    : "";
  return `<div class="top-nav">
  <div class="top-nav-bar">
    <a class="top-nav-brand" href="/home" aria-label="pane home">
      <svg width="18" height="18" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${BRAND_MARK_SVG_BODY}</svg>
      <span class="wordmark">pane</span>
    </a>
    <div class="top-nav-presence">
      <span class="pill" aria-label="WebSocket connection state">
        <svg class="pill-icon" width="13" height="13" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 17H7A5 5 0 0 1 7 7h2"/>
          <path d="M15 7h2a5 5 0 0 1 0 10h-2"/>
          <line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
        <span id="dot" class="dot"></span>
        <span id="status" class="info">connecting...</span>
      </span>
      <span class="pill" aria-label="Agent presence">
        <svg class="pill-icon" width="13" height="13" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="4" y="9" width="16" height="11" rx="2.5"/>
          <path d="M12 9V5"/>
          <circle cx="12" cy="3.5" r="1.6"/>
          <line x1="9" y1="14" x2="9" y2="14.5"/>
          <line x1="15" y1="14" x2="15" y2="14.5"/>
        </svg>
        <span id="agent-dot" class="dot"></span>
        <span id="agent-status" class="info">${closedLabel}</span>
      </span>
    </div>
    <div class="top-nav-account">
      ${shareBtn}
      <button id="top-nav-signout" class="top-nav-signout" type="button">Sign out</button>
    </div>
  </div>
</div>`;
}

// The in-page Share dialog markup — a Google-Docs-style People + General-access
// panel, ported from the owner dashboard's share modal so the two read as a set
// and stay behaviourally identical. Rendered (and driven by shareModalScript)
// only for the owner — see renderTopNav's `canShare` gate. All dynamic grant /
// email data is injected client-side with textContent, never innerHTML.
function renderShareModal(): string {
  return `<div class="share-modal" id="share-modal" hidden>
  <div class="share-backdrop" data-share-close></div>
  <div class="share-card" role="dialog" aria-modal="true" aria-labelledby="share-title">
    <button class="share-x" data-share-close aria-label="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="share-head">
      <h2 id="share-title">Share</h2>
      <div class="share-sub" id="share-pane-title"></div>
    </div>
    <div class="share-err" id="share-err" hidden></div>
    <div class="share-sec">
      <h3>People</h3>
      <form class="share-invite" id="share-invite-form">
        <input id="share-email" type="email" placeholder="Add people by email" autocomplete="off" inputmode="email" aria-label="Email to invite" />
        <select id="share-role" aria-label="Role for the invited person">
          <option value="participant">Participant</option>
          <option value="viewer">Viewer</option>
        </select>
        <button id="share-invite-btn" type="submit" class="btn primary small">Invite</button>
      </form>
      <ul class="share-grants" id="share-grants"></ul>
    </div>
    <div class="share-sec">
      <h3>General access</h3>
      <div class="share-access">
        <select id="share-visibility" aria-label="General access">
          <option value="invite_only">Invite only</option>
          <option value="link">Anyone with the link</option>
          <option value="public">Public</option>
        </select>
        <button id="share-visibility-toggle" type="button" class="btn"></button>
        <div class="share-access-note" id="share-access-note"></div>
      </div>
    </div>
    <div class="share-foot">
      <button id="share-copy-link" type="button" class="btn">Copy link</button>
      <div class="share-link-hint" id="share-link-hint"></div>
    </div>
  </div>
</div>`;
}

// Client logic for the Share dialog. Backed by the cookie-authed
// /v1/my-panes/:id/{grants,visibility,share-link} routes (the owner-shell page
// carries the pane_login cookie; fetches are same-origin so the owner-shell
// CSP's `connect-src 'self'` covers them). Ported from the dashboard SPA's
// share modal; the only behavioural change is the open trigger — the SPA opens
// from per-row buttons via `data-pane-share`, whereas here the pane id is fixed
// (this is a single-pane surface) so the top-nav Share button opens it directly.
function shareModalScript(
  paneId: string,
  title: string,
  nonce: string,
): string {
  // Inject the server-known pane id + title as JS string literals. JSON.stringify
  // quotes/escapes them; the `<` replacement closes the one `</script>` breakout
  // the HTML script-data state machine cares about.
  const esc = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");
  return `<script nonce="${nonce}">
  (function () {
    var PANE_ID = ${esc(paneId)};
    var PANE_TITLE = ${esc(title)};
    var shareBtn = document.getElementById('top-nav-share');
    var modal = document.getElementById('share-modal');
    var card = modal && modal.querySelector('.share-card');
    var subEl = document.getElementById('share-pane-title');
    var errEl = document.getElementById('share-err');
    var inviteForm = document.getElementById('share-invite-form');
    var emailEl = document.getElementById('share-email');
    var roleEl = document.getElementById('share-role');
    var inviteBtn = document.getElementById('share-invite-btn');
    var grantsEl = document.getElementById('share-grants');
    var visEl = document.getElementById('share-visibility');
    var visToggle = document.getElementById('share-visibility-toggle');
    var accessNote = document.getElementById('share-access-note');
    var copyBtn = document.getElementById('share-copy-link');
    var linkHint = document.getElementById('share-link-hint');
    if (!shareBtn || !modal || !card || !inviteForm || !emailEl || !roleEl || !grantsEl || !visEl || !copyBtn) return;

    var lastFocus = null;
    var shareToken = null; // minted lazily on first "Copy link"

    function showErr(msg) { if (!errEl) return; errEl.textContent = msg; errEl.hidden = false; }
    function clearErr() { if (errEl) { errEl.hidden = true; errEl.textContent = ''; } }
    async function readErr(res) {
      var body = await res.json().catch(function () { return {}; });
      return (body && body.error && body.error.message) || ('HTTP ' + res.status);
    }
    function paneUrl(id) { return location.origin + '/p/' + encodeURIComponent(id); }

    var currentMode = 'link';
    function normMode(m) { return (m === 'invite_only' || m === 'link' || m === 'public') ? m : 'link'; }
    function setAccessNote(mode) {
      if (!accessNote) return;
      accessNote.textContent =
        mode === 'invite_only' ? 'Only invited people can open this pane.'
        : mode === 'public' ? 'Anyone can open this; it may be listed publicly.'
        : 'Anyone with the link can open this, no sign-in.';
    }
    function setToggleButton(mode) {
      if (!visToggle) return;
      visToggle.textContent = '';
      if (mode === 'public') {
        visToggle.classList.remove('primary');
        var l1 = document.createElement('span'); l1.textContent = 'Make invite only';
        visToggle.appendChild(l1);
        visToggle.setAttribute('aria-label', 'Make this pane invite only');
      } else {
        visToggle.classList.add('primary');
        var icon = document.createElement('span');
        icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
        var l2 = document.createElement('span'); l2.textContent = 'Make public';
        visToggle.appendChild(icon); visToggle.appendChild(l2);
        visToggle.setAttribute('aria-label', 'Make this pane public');
      }
    }
    function reflectVisibility(mode) {
      var m = normMode(mode);
      currentMode = m; visEl.value = m;
      setAccessNote(m); setToggleButton(m); updateLinkHint();
    }
    async function applyVisibility(mode) {
      var next = normMode(mode); var prev = currentMode;
      clearErr(); visEl.disabled = true; if (visToggle) visToggle.disabled = true;
      try {
        var res = await fetch('/v1/my-panes/' + encodeURIComponent(PANE_ID) + '/visibility', {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ access_mode: next }),
        });
        if (!res.ok) { showErr('Could not change access: ' + (await readErr(res))); reflectVisibility(prev); return; }
        reflectVisibility(next);
      } catch (e) { showErr('Network error — try again.'); reflectVisibility(prev); }
      finally { visEl.disabled = false; if (visToggle) visToggle.disabled = false; }
    }
    function renderGrants(items) {
      grantsEl.textContent = '';
      if (!items.length) {
        var empty = document.createElement('li');
        empty.className = 'share-grants-empty';
        empty.textContent = 'No one invited yet.';
        grantsEl.appendChild(empty); return;
      }
      for (var i = 0; i < items.length; i++) {
        var g = items[i];
        var li = document.createElement('li');
        li.className = 'share-grant'; li.setAttribute('data-grant-id', g.id);
        var who = document.createElement('div'); who.className = 'who';
        var email = document.createElement('div'); email.className = 'email';
        email.textContent = g.invite_email || g.human_id || 'unknown';
        var role = document.createElement('div'); role.className = 'role';
        role.textContent = (g.role === 'viewer' ? 'Viewer' : 'Participant');
        who.appendChild(email); who.appendChild(role); li.appendChild(who);
        if (!g.accepted_at) {
          var pending = document.createElement('span');
          pending.className = 'pending'; pending.textContent = 'pending';
          li.appendChild(pending);
        }
        var revoke = document.createElement('button');
        revoke.className = 'revoke'; revoke.type = 'button'; revoke.title = 'Remove';
        revoke.setAttribute('aria-label', 'Remove ' + email.textContent);
        revoke.setAttribute('data-revoke-grant', g.id);
        revoke.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        li.appendChild(revoke); grantsEl.appendChild(li);
      }
    }
    async function openShare() {
      shareToken = null; clearErr();
      if (subEl) subEl.textContent = PANE_TITLE || PANE_ID;
      grantsEl.textContent = '';
      if (linkHint) linkHint.textContent = '';
      copyBtn.textContent = 'Copy link';
      lastFocus = document.activeElement;
      modal.hidden = false;
      try {
        var res = await fetch('/v1/my-panes/' + encodeURIComponent(PANE_ID) + '/grants', { credentials: 'same-origin' });
        if (!res.ok) { showErr('Could not load sharing: ' + (await readErr(res))); return; }
        var body = await res.json();
        renderGrants(Array.isArray(body.items) ? body.items : []);
        reflectVisibility(body.access_mode);
      } catch (e) { showErr('Network error loading sharing.'); }
      emailEl.focus();
    }
    function closeShare() {
      modal.hidden = true;
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    }
    shareBtn.addEventListener('click', function (ev) { ev.preventDefault(); openShare(); });

    inviteForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var email = (emailEl.value || '').trim();
      if (!email) { emailEl.focus(); return; }
      clearErr(); inviteBtn.disabled = true;
      try {
        var res = await fetch('/v1/my-panes/' + encodeURIComponent(PANE_ID) + '/grants', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: email, role: roleEl.value }),
        });
        if (!res.ok) { showErr('Invite failed: ' + (await readErr(res))); return; }
        var listRes = await fetch('/v1/my-panes/' + encodeURIComponent(PANE_ID) + '/grants', { credentials: 'same-origin' });
        if (listRes.ok) { var body = await listRes.json(); renderGrants(Array.isArray(body.items) ? body.items : []); }
        emailEl.value = ''; emailEl.focus();
      } catch (e) { showErr('Network error — try again.'); }
      finally { inviteBtn.disabled = false; }
    });

    grantsEl.addEventListener('click', async function (ev) {
      var btn = ev.target instanceof HTMLElement && ev.target.closest('button[data-revoke-grant]');
      if (!btn) return;
      var gid = btn.getAttribute('data-revoke-grant');
      if (!gid) return;
      clearErr(); btn.disabled = true;
      try {
        var res = await fetch('/v1/my-panes/' + encodeURIComponent(PANE_ID) + '/grants/' + encodeURIComponent(gid), { method: 'DELETE', credentials: 'same-origin' });
        if (!res.ok && res.status !== 204) { showErr('Remove failed: ' + (await readErr(res))); btn.disabled = false; return; }
        var row = grantsEl.querySelector('[data-grant-id="' + CSS.escape(gid) + '"]');
        if (row) row.remove();
        if (!grantsEl.querySelector('.share-grant')) renderGrants([]);
      } catch (e) { showErr('Network error — try again.'); btn.disabled = false; }
    });

    visEl.addEventListener('change', function () { applyVisibility(visEl.value); });
    if (visToggle) {
      visToggle.addEventListener('click', function () {
        applyVisibility(currentMode === 'public' ? 'invite_only' : 'public');
      });
    }

    function updateLinkHint() {
      if (!linkHint) return;
      if (currentMode === 'public') {
        linkHint.textContent = 'Public link: ' + paneUrl(PANE_ID) + ' — anyone can open it, no sign-in.';
      } else if (currentMode === 'invite_only') {
        linkHint.textContent = 'Invite-only link: ' + paneUrl(PANE_ID) + ' — invited people sign in to open it.';
      } else {
        linkHint.textContent = shareToken
          ? 'Immediate-view link copied — anyone with it can open the pane.'
          : 'Copy link gives an immediate-view /s link — anyone with it can open the pane, no sign-in.';
      }
    }
    async function copy(text) {
      try { await navigator.clipboard.writeText(text); return true; }
      catch (e) {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        var ok = false; try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
        document.body.removeChild(ta); return ok;
      }
    }
    copyBtn.addEventListener('click', async function () {
      clearErr(); copyBtn.disabled = true;
      var orig = copyBtn.textContent;
      try {
        var toCopy;
        if (currentMode === 'public' || currentMode === 'invite_only') {
          toCopy = paneUrl(PANE_ID);
        } else {
          if (!shareToken) {
            var res = await fetch('/v1/my-panes/' + encodeURIComponent(PANE_ID) + '/share-link', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' }, body: '{}',
            });
            if (!res.ok) { showErr('Could not create link: ' + (await readErr(res))); return; }
            var body = await res.json(); shareToken = body.url;
          }
          toCopy = shareToken;
        }
        var ok = await copy(toCopy);
        copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        updateLinkHint();
        setTimeout(function () { copyBtn.textContent = orig; }, 1400);
      } catch (e) { showErr('Network error — try again.'); }
      finally { copyBtn.disabled = false; }
    });

    var closers = modal.querySelectorAll('[data-share-close]');
    for (var j = 0; j < closers.length; j++) closers[j].addEventListener('click', closeShare);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !modal.hidden) { ev.preventDefault(); closeShare(); }
    });
  })();
</script>`;
}

export function renderShell(args: ShellArgs): string {
  const cfg = {
    paneId: args.paneId,
    schema: args.schema,
    inputData: args.inputData,
    presenceUrl: args.presenceUrl,
    wsTicketUrl: args.wsTicketUrl,
    wsTicketAuthorization: args.wsTicketAuthorization,
    attachmentsUploadUrl: args.attachmentsUploadUrl,
    attachmentsDownloadUrlBase: args.attachmentsDownloadUrlBase,
    wsUrl: args.wsUrl,
    isClosed: args.isClosed,
    agentLive: args.agentLive,
    agentLastEventAt: args.agentLastEventAt,
    agentLastUsedAt: args.agentLastUsedAt,
  };
  // `<script type="application/json">` is parsed as raw text by the HTML
  // script-data state machine — `</script>` is the only terminator. We
  // neutralise it the same way we'd neutralise any HTML text node: escape `<`.
  // (JSON.stringify already emits valid JSON; we just close the one breakout.)
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f7f5f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14110d" media="(prefers-color-scheme: dark)">
<title>${htmlEscape(args.title)}</title>
<link rel="icon" type="image/svg+xml" href="${BRAND_FAVICON_HREF}">
<link rel="apple-touch-icon" sizes="180x180" href="${args.appleTouchIconHref}">
<style nonce="${args.nonce}">
  /* Shell-chrome tokens — the "Warm Sunset" palette (coral #D97757 accent),
     matching the marketing site. Dark defaults below are a warm charcoal;
     the light override at the bottom is warm-paper. Prefixed --pv-* so they
     can't collide with the iframe'd agent content (a separate document
     anyway). The brand-logo SVG fills (#D97757 etc.) are artwork and are
     intentionally NOT tokenized. */
  :root {
    color-scheme: light dark;
    --pv-bg:         #14110d;
    --pv-bg-elev:    #211b14;
    --pv-hairline:   #2a231a;
    --pv-ink:        #ece3d6;
    --pv-ink-strong: #f3ece2;
    --pv-muted:      #a89c89;
    --pv-accent:       #e8906b;
    --pv-accent-hover: #f2a684;
    --pv-green: #7CE3B1;
    --pv-amber: #f7c66a;
    --pv-red:   #f07178;
    --pv-dim:   #6b6051;
    /* gradient endpoints for the header / preamble bands */
    --pv-grad-1: #1b1611;
    --pv-grad-pre-1: #211b14;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --pv-bg:         #f7f5f1;
      --pv-bg-elev:    #ffffff;
      --pv-hairline:   #e6e0d6;
      --pv-ink:        #1a1726;
      --pv-ink-strong: #1a1726;
      --pv-muted:      #5b5570;
      --pv-accent:       #D97757;
      --pv-accent-hover: #c4633f;
      --pv-green: #059669;
      --pv-amber: #b45309;
      --pv-red:   #e11d48;
      --pv-dim:   #c9c0b2;
      --pv-grad-1:     #efece5;
      --pv-grad-pre-1: #f1ece2;
    }
  }
  html, body { height: 100%; margin: 0; }
  body {
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--pv-bg); color: var(--pv-ink);
    display: flex; flex-direction: column;
  }
  header {
    padding: 9px 14px; font-size: 13px;
    display: flex; align-items: center; gap: 10px;
    background: linear-gradient(180deg, var(--pv-grad-1) 0%, var(--pv-bg) 100%);
    border-bottom: 1px solid var(--pv-hairline);
  }
  .brand {
    display: inline-flex; align-items: center; gap: 7px;
    user-select: none;
    text-decoration: none; color: inherit;
  }
  .brand:hover .brand-name { opacity: 0.85; }
  .brand-logo { display: block; flex: none; }
  .brand-name {
    font-weight: 600; font-size: 14px; letter-spacing: 0.2px;
    color: var(--pv-ink-strong);
  }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px 3px 8px; border-radius: 999px;
    background: var(--pv-bg-elev); border: 1px solid var(--pv-hairline);
  }
  .pill-icon { display: block; flex: none; color: var(--pv-muted); }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--pv-dim); flex: none;
  }
  .dot.up {
    background: var(--pv-green);
    animation: pulse 2s ease-in-out infinite;
  }
  .dot.dn { background: var(--pv-red); }
  .dot.amber { background: var(--pv-amber); }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(124, 227, 177, 0.45); }
    50%      { box-shadow: 0 0 0 4px rgba(124, 227, 177, 0); }
  }
  .info { color: var(--pv-muted); }
  .spacer { flex: 1; }
  iframe { border: 0; flex: 1; width: 100%; background: white; display: block; }
  .closed {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: var(--pv-muted); font-size: 14px;
  }
  /* Optional top-nav block — same palette as the rest of the shell, so
     the system-pages tabs sit naturally above the presence header instead
     of injecting a contrasting visual break. */
  .top-nav {
    background: var(--pv-bg); border-bottom: 1px solid var(--pv-hairline);
    padding-top: env(safe-area-inset-top);
  }
  .top-nav-bar {
    display: flex; align-items: center; gap: 12px;
    padding: 9px max(14px, env(safe-area-inset-left)) 9px max(14px, env(safe-area-inset-right));
  }
  .top-nav-brand {
    display: inline-flex; align-items: center; gap: 7px;
    text-decoration: none; color: var(--pv-ink-strong); flex: none;
  }
  .top-nav-brand .wordmark { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
  /* Presence pills inside the top nav. Pushed to the right via margin-left:auto
     on the FIRST trailing block; the account block then sits next to it
     without claiming the auto-margin a second time. */
  .top-nav-presence { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
  .top-nav-presence .pill { padding: 2px 8px 2px 7px; font-size: 12px; }
  .top-nav-account { display: flex; align-items: center; gap: 8px; min-width: 0; }
  /* On narrow viewports the presence pills wrap to the next visual line; the
     status text is short enough that the icon + dot still reads at a glance,
     so we ellipsis-truncate the .info span before the pill itself collapses. */
  @media (max-width: 540px) {
    .top-nav-presence .info { display: none; }
    /* Collapse the Share button to its icon when space is tight. */
    .top-nav-share .label { display: none; }
  }
  /* Share button in the account block — accent-tinted so it reads as the
     primary action of the bar, next to the quieter Sign out. */
  .top-nav-share {
    display: inline-flex; align-items: center; gap: 6px; flex: none;
    background: transparent; border: 1px solid var(--pv-hairline);
    color: var(--pv-ink); font: inherit; font-size: 12px;
    padding: 5px 10px; border-radius: 7px; cursor: pointer;
  }
  .top-nav-share svg { display: block; }
  .top-nav-share:hover { border-color: var(--pv-accent); color: var(--pv-accent-hover); }
  .top-nav-signout {
    background: transparent; border: 1px solid var(--pv-hairline); color: var(--pv-muted);
    font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 7px;
    cursor: pointer; flex: none;
  }
  .top-nav-signout:hover { border-color: var(--pv-accent); color: var(--pv-accent-hover); }
  /* Agent-supplied context band — sits between any header / top-nav and the
     iframe. The accent stripe + speech-bubble glyph telegraphs "this is the
     agent talking to you" so the message reads as context, not chrome. */
  .preamble {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 10px 14px 11px;
    background: linear-gradient(180deg, var(--pv-grad-pre-1) 0%, var(--pv-bg) 100%);
    border-bottom: 1px solid var(--pv-hairline);
    border-left: 3px solid var(--pv-accent);
    color: var(--pv-ink); font-size: 13px; line-height: 1.45;
    white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere;
  }
  .preamble-icon {
    flex: none; color: var(--pv-accent); margin-top: 1px;
  }
  .preamble-text { flex: 1; min-width: 0; }
  /* Share dialog — ported from the owner dashboard's share modal, remapped to
     the shell's --pv-* palette so it reads as part of the pane chrome. */
  .share-modal {
    position: fixed; inset: 0; z-index: 1200;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .share-modal[hidden] { display: none; }
  .share-backdrop {
    position: absolute; inset: 0;
    background: rgba(8, 6, 4, 0.55); backdrop-filter: blur(2px);
  }
  .share-card {
    position: relative; z-index: 1; width: 100%; max-width: 460px;
    max-height: calc(100vh - 40px); overflow-y: auto;
    background: var(--pv-bg-elev); color: var(--pv-ink);
    border: 1px solid var(--pv-hairline); border-radius: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); padding: 22px;
  }
  .share-x {
    position: absolute; top: 12px; right: 12px; width: 30px; height: 30px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: none; color: var(--pv-muted);
    cursor: pointer; border-radius: 8px;
  }
  .share-x:hover { color: var(--pv-ink); background: var(--pv-bg); }
  .share-head h2 { margin: 0 28px 2px 0; font-size: 18px; }
  .share-sub {
    color: var(--pv-muted); font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .share-err {
    margin-top: 12px; padding: 8px 10px; border-radius: 8px;
    background: rgba(240, 113, 120, 0.12); border: 1px solid rgba(240, 113, 120, 0.35);
    color: var(--pv-red); font-size: 12.5px;
  }
  .share-err[hidden] { display: none; }
  .share-sec { margin-top: 18px; }
  .share-sec h3 {
    margin: 0 0 8px; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--pv-muted); font-weight: 600;
  }
  .share-invite { display: flex; gap: 6px; align-items: stretch; }
  .share-invite input {
    flex: 1 1 auto; min-width: 0;
    background: var(--pv-bg); border: 1px solid var(--pv-hairline);
    border-radius: 8px; padding: 7px 10px; color: var(--pv-ink);
    font-size: 13px; font-family: inherit;
  }
  .share-invite input:focus { outline: none; border-color: var(--pv-accent); }
  .share-invite select, #share-visibility {
    background: var(--pv-bg); border: 1px solid var(--pv-hairline);
    border-radius: 8px; padding: 7px 8px; color: var(--pv-ink);
    font-size: 13px; font-family: inherit; cursor: pointer;
  }
  .share-grants { list-style: none; margin: 10px 0 0; padding: 0; }
  .share-grant {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 0; border-top: 1px solid var(--pv-hairline);
  }
  .share-grant .who { flex: 1 1 auto; min-width: 0; }
  .share-grant .email {
    font-size: 13px; color: var(--pv-ink);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .share-grant .role { font-size: 11px; color: var(--pv-muted); }
  .share-grant .pending {
    font-size: 10px; font-weight: 600; letter-spacing: 0.03em;
    padding: 2px 6px; border-radius: 999px; color: var(--pv-muted);
    background: var(--pv-bg); border: 1px solid var(--pv-hairline);
  }
  .share-grant .revoke {
    background: transparent; border: none; color: var(--pv-muted);
    cursor: pointer; padding: 4px; border-radius: 6px; line-height: 0;
  }
  .share-grant .revoke:hover { color: var(--pv-red); }
  .share-grants-empty { color: var(--pv-muted); font-size: 12.5px; padding: 8px 0 0; }
  .share-access { display: flex; flex-direction: column; gap: 8px; }
  #share-visibility { width: 100%; }
  #share-visibility-toggle { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; }
  #share-visibility-toggle svg { display: block; }
  .share-access-note { color: var(--pv-muted); font-size: 12px; }
  .share-foot {
    margin-top: 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  .share-link-hint { color: var(--pv-muted); font-size: 12px; flex: 1 1 160px; }
  /* .btn — scoped to the share dialog so it can't collide with the iframe's
     own content. Mirrors the dashboard's button styling on the --pv-* palette. */
  .share-modal .btn {
    background: var(--pv-bg); border: 1px solid var(--pv-hairline);
    border-radius: 8px; color: var(--pv-muted); padding: 6px 12px;
    font-size: 12.5px; font-family: inherit; cursor: pointer;
    transition: color 100ms, border-color 100ms;
  }
  .share-modal .btn:hover { color: var(--pv-ink); border-color: var(--pv-accent); }
  .share-modal .btn.primary {
    background: var(--pv-accent); color: #1a120c; border-color: transparent; font-weight: 600;
  }
  .share-modal .btn.primary:hover { filter: brightness(1.08); color: #1a120c; }
  .share-modal .btn.small { padding: 6px 10px; }
  .share-modal .btn[disabled] { opacity: 0.55; cursor: default; }
</style>
</head>
<body>
${renderTopNav(args)}${
    args.topNav
      ? // Top-nav mode already carries the brand + presence pills inline,
        // so we skip the standalone dark `<header>` block — otherwise the
        // shell shows three header rows (brand, presence, tabs) for one
        // page's worth of context.
        ""
      : // Standalone header — runs on /s/<token> (anonymous capability-link
        // mount) and on /p/:paneId when not signed in. Both audiences see the
        // landing page at /, not the owner's /home (which is logged-in-only).
        // The owner's mount renders the top-nav variant above with /home.
        `<header>
  <a class="brand" href="/" aria-label="pane home">
    <svg class="brand-logo" width="20" height="20" viewBox="0 0 100 100" aria-hidden="true">${BRAND_MARK_SVG_BODY}</svg>
    <span class="brand-name">Pane</span>
  </a>
  <span class="spacer"></span>
  <span class="pill">
    <svg class="pill-icon" width="13" height="13" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 17H7A5 5 0 0 1 7 7h2"/>
      <path d="M15 7h2a5 5 0 0 1 0 10h-2"/>
      <line x1="8" y1="12" x2="16" y2="12"/>
    </svg>
    <span id="dot" class="dot"></span>
    <span id="status" class="info">connecting...</span>
  </span>
  <span class="pill">
    <svg class="pill-icon" width="13" height="13" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="9" width="16" height="11" rx="2.5"/>
      <path d="M12 9V5"/>
      <circle cx="12" cy="3.5" r="1.6"/>
      <line x1="9" y1="14" x2="9" y2="14.5"/>
      <line x1="15" y1="14" x2="15" y2="14.5"/>
    </svg>
    <span id="agent-dot" class="dot"></span>
    <span id="agent-status" class="info">${args.isClosed ? "pane closed" : "no agent yet"}</span>
  </span>
</header>`
  }
${
  args.preamble
    ? `<div class="preamble" role="note">
  <svg class="preamble-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
  <span class="preamble-text">${htmlEscape(args.preamble)}</span>
</div>`
    : ""
}${
    args.isClosed
      ? `<div class="closed">This pane is closed. It cannot accept new events.</div>`
      : // `allow-downloads` is required for `<a download href="attachment:...">` to
        // actually fire on Chromium-based browsers (especially mobile Chrome),
        // which silently drops the navigation otherwise. Without it, an template
        // that delivers a non-image file (PDF, CSV, archive) the human is meant
        // to save has no working code path — the file can be fetched via
        // window.pane.downloadBlob() but never reaches the disk.
        //
        // `allow-top-navigation-by-user-activation` lets a template link out
        // (e.g. `<a target="_top" href="/s/...">` — a demo index linking to the
        // other demo panes) by navigating the WHOLE tab on a real user click.
        // Chosen over `allow-popups`: the destination loads as a normal
        // top-level document (so a linked pane actually works, vs. a popup that
        // would stay sandboxed and broken), it's gated on user activation (no
        // silent/background redirects), and it opens no new windows.
        // `allow-popups` and `allow-same-origin` remain omitted, so the framed
        // document itself still runs at an opaque origin and can't spawn windows.
        `<iframe id="frame" sandbox="allow-scripts allow-forms allow-downloads allow-top-navigation-by-user-activation" src="${htmlEscape(args.iframeContentUrl)}"></iframe>`
  }${args.topNav?.canShare ? `\n${renderShareModal()}` : ""}
<script type="application/json" id="pane-cfg">${cfgJson}</script>
<script nonce="${args.nonce}">${SHELL_JS}</script>${
    args.topNav
      ? `
<script nonce="${args.nonce}">
  document.getElementById("top-nav-signout")?.addEventListener("click", async () => {
    try { await fetch("/v1/auth/logout", { method: "POST", credentials: "same-origin" }); } catch {}
    location.href = "/login";
  });
</script>`
      : ""
  }${
    args.topNav?.canShare
      ? `\n${shareModalScript(args.paneId, args.title, args.nonce)}`
      : ""
  }
</body>
</html>`;
}

// Bridge-route error renderer. The /v1/* API always speaks JSON envelopes
// (agents depend on the structured shape), but /s/:token is a human-facing
// URL: when a person opens a stale link in a browser they should see a
// styled HTML page, not raw JSON.
//
// We content-negotiate per request — if the client's Accept header prefers
// text/html over application/json we render the page; otherwise we re-throw
// and let the global onError handler emit the JSON envelope unchanged. curl
// with the default `Accept: */*` keeps getting JSON, which preserves the
// existing agent/test ergonomics.
function humanOrJsonError(c: Context<AppEnv>, err: ApiError): Response {
  if (!prefersHtml(c.req.header("Accept"))) {
    throw err;
  }
  const page = errorPageFor(err);
  // Same defence-in-depth headers as the shell. We omit CSP nonces because
  // the error page has no inline <script>; an inline <style> stays under a
  // single 'self' style-src so we don't need per-request nonces.
  c.header("Content-Security-Policy", ERROR_CSP);
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Permissions-Policy", PERMISSIONS_POLICY);
  c.header("Cache-Control", "private, no-store");
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(page, err.status as 404 | 410);
}

// Stricter than the shell's CSP — the error page has no script, no iframe,
// no remote connection. 'unsafe-inline' on style only, scoped to the page's
// own <style> block.
const ERROR_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

interface ErrorPageCopy {
  // Short browser-tab title (≤ ~24 chars). Combined with the "Pane — " brand
  // prefix so the tab stays readable when several are open.
  tabTitle: string;
  // The headline shown in the body of the page.
  headline: string;
  body: string;
}

// The status-code-keyed copy. 404 covers "unknown token | revoked
// participant | pane row deleted" — all three look identical in the
// rendered page on purpose, so the bridge isn't a participant-token
// enumeration oracle. 410 covers TTL-expired and explicitly-closed panes
// reached through the /content sub-route.
function errorPageFor(err: ApiError): string {
  const copy: ErrorPageCopy =
    err.status === 410
      ? {
          tabTitle: "Closed",
          headline: "This pane has been closed",
          body: "The pane has expired or been closed by the agent. Ask for a new link if you still need to act.",
        }
      : {
          tabTitle: "Not found",
          headline: "This pane link isn't valid",
          body: "The link may be mistyped, or the pane may have been cleaned up. Ask the agent for a fresh one.",
        };
  return renderHumanError(copy);
}

// HTML-escape user-supplied or status-driven text. The current copy is all
// static literals, but the helper exists so future copy changes can't
// accidentally inject markup.
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHumanError(copy: ErrorPageCopy): string {
  const tabTitle = htmlEscape(copy.tabTitle);
  const headline = htmlEscape(copy.headline);
  const body = htmlEscape(copy.body);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f7f5f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14110d" media="(prefers-color-scheme: dark)">
<title>Pane — ${tabTitle}</title>
<link rel="icon" type="image/svg+xml" href="${BRAND_FAVICON_HREF}">
<style>
  /* Standalone error/closed page. Same --pv-* token model as the viewer shell
     so dark stays byte-identical and light follows the device. */
  :root {
    color-scheme: light dark;
    --pv-bg:         #14110d;
    --pv-hairline:   #2a231a;
    --pv-ink:        #ece3d6;
    --pv-ink-strong: #f3ece2;
    --pv-muted:      #a89c89;
    --pv-green:      #7CE3B1;
    --pv-grad-1:     #1b1611;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --pv-bg:         #f7f5f1;
      --pv-hairline:   #e6e0d6;
      --pv-ink:        #1a1726;
      --pv-ink-strong: #1a1726;
      --pv-muted:      #5b5570;
      --pv-green:      #059669;
      --pv-grad-1:     #efece5;
    }
  }
  html, body { height: 100%; margin: 0; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--pv-bg); color: var(--pv-ink);
    display: flex; flex-direction: column;
  }
  header {
    padding: 9px 14px; font-size: 13px;
    display: flex; align-items: center; gap: 10px;
    background: linear-gradient(180deg, var(--pv-grad-1) 0%, var(--pv-bg) 100%);
    border-bottom: 1px solid var(--pv-hairline);
  }
  .brand {
    display: inline-flex; align-items: center; gap: 7px;
    user-select: none;
    text-decoration: none; color: inherit; border-bottom: 0;
  }
  .brand:hover { border-bottom: 0; }
  .brand:hover .brand-name { opacity: 0.85; }
  .brand-logo { display: block; flex: none; }
  .brand-name {
    font-weight: 600; font-size: 14px; letter-spacing: 0.2px;
    color: var(--pv-ink-strong);
  }
  main {
    flex: 1; display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    max-width: 480px; text-align: center;
  }
  h1 {
    margin: 0 0 12px; font-size: 20px; font-weight: 600;
    color: var(--pv-ink-strong); letter-spacing: 0.2px;
  }
  p { margin: 0 0 18px; color: var(--pv-muted); }
  a {
    color: var(--pv-green); text-decoration: none;
    border-bottom: 1px solid rgba(124, 227, 177, 0.3);
  }
  a:hover { border-bottom-color: var(--pv-green); }
</style>
</head>
<body>
<header>
  <a class="brand" href="/" aria-label="pane home">
    <svg class="brand-logo" width="20" height="20" viewBox="0 0 100 100" aria-hidden="true">${BRAND_MARK_SVG_BODY}</svg>
    <span class="brand-name">Pane</span>
  </a>
</header>
<main>
  <div class="card">
    <h1>${headline}</h1>
    <p>${body}</p>
    <p><a href="https://paneui.com" rel="noopener noreferrer">What is Pane?</a></p>
  </div>
</main>
</body>
</html>`;
}

export default bridge;
