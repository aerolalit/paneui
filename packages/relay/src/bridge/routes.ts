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
import { paneAppleTouchIcon } from "../http/routes/apple-touch-icon.js";

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
      return humanOrJsonError(c, err);
    }
    throw err;
  }
  const { pane, participant } = loaded;

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

  // Effective IMAGE icon: pane override → template fallback. (loadByToken's pane
  // row carries the pane's own iconAttachmentId; the template's lives one join
  // away, fetched only when the pane has no override.)
  let effective = pane.iconAttachmentId;
  if (!effective) {
    const withTpl = await prisma.pane.findUnique({
      where: { id: pane.id },
      select: {
        templateVersion: {
          select: { template: { select: { iconAttachmentId: true } } },
        },
      },
    });
    effective = withTpl?.templateVersion?.template?.iconAttachmentId ?? null;
  }

  const { png, etag } = await paneAppleTouchIcon(
    c.get("blobStore"),
    prisma,
    effective,
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

  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      // 'unsafe-inline' only — no nonce. CSP3 browsers ignore 'unsafe-inline'
      // when a nonce is present, which would block the agent's own inline
      // <script> tags inside artifactBody. The runtime is just another inline
      // script under the same sandbox; both are covered by 'unsafe-inline'.
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data: attachment:",
      // Audio / video the agent uploads as attachments and the iframe renders via
      // <audio src="attachment:…"> or <video src="attachment:…"> after lazy-fetching with
      // window.pane.downloadBlob(). Without this directive, `media-src` falls
      // back to `default-src 'none'` and blocks both elements.
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
  // email + sign out) rendered above the iframe for a logged-in pane owner.
  // No system-page tabs: a pane viewer is a focused, single-pane surface, so
  // it carries only "where am I / what's the relay doing / who am I" chrome.
  // The capability-token mount (/s/<token>) leaves this null — anonymous
  // callers get no account bar at all.
  topNav: { email: string } | null;
  // Href for the iOS home-screen icon (apple-touch-icon). The /s/<token> mount
  // points at this pane's own icon route (`/s/<token>/icon.png` — the pane's
  // effective image icon, else the robot default); the owner mount keeps the
  // static `/apple-touch-icon.png` (its icon route is cookie-gated and iOS may
  // fetch the icon without the cookie).
  appleTouchIconHref: string;
}

function renderTopNav(args: ShellArgs): string {
  if (!args.topNav) return "";
  const { email } = args.topNav;
  // Presence pills live in the SAME bar as the brand + account — one row for
  // "where am I" (brand) and "what is the relay doing" (presence) beside the
  // email, so the eye picks up both states without scanning vertically.
  const closedLabel = args.isClosed ? "pane closed" : "no agent yet";
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
      <span class="top-nav-email" title="${htmlEscape(email)}">${htmlEscape(email)}</span>
      <button id="top-nav-signout" class="top-nav-signout" type="button">Sign out</button>
    </div>
  </div>
</div>`;
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
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0e14" media="(prefers-color-scheme: dark)">
<title>${htmlEscape(args.title)}</title>
<link rel="icon" type="image/svg+xml" href="${BRAND_FAVICON_HREF}">
<link rel="apple-touch-icon" sizes="180x180" href="${args.appleTouchIconHref}">
<style nonce="${args.nonce}">
  /* Shell-chrome tokens. Dark defaults below are the original hardcoded hex
     values (kept byte-identical); the light override at the bottom adapts the
     chrome to the device. Prefixed --pv-* so they can't collide with the
     iframe'd agent content (a separate document anyway). The brand-logo SVG
     fills (#0f172a etc.) are artwork and are intentionally NOT tokenized. */
  :root {
    color-scheme: light dark;
    --pv-bg:         #0b0e14;
    --pv-bg-elev:    #141a26;
    --pv-hairline:   #1f2633;
    --pv-ink:        #d7dee9;
    --pv-ink-strong: #e7ecf3;
    --pv-muted:      #8a93a6;
    --pv-accent:       #a78bfa;
    --pv-accent-hover: #cdbcff;
    --pv-green: #7CE3B1;
    --pv-amber: #f7c66a;
    --pv-red:   #f07178;
    --pv-dim:   #5b6477;
    /* gradient endpoints for the header / preamble bands */
    --pv-grad-1: #10141d;
    --pv-grad-pre-1: #0e1320;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --pv-bg:         #ffffff;
      --pv-bg-elev:    #f6f7f9;
      --pv-hairline:   #e4e7ee;
      --pv-ink:        #1a2030;
      --pv-ink-strong: #1a2030;
      --pv-muted:      #56607a;
      --pv-accent:       #6d5ef0;
      --pv-accent-hover: #5b4bd8;
      --pv-green: #059669;
      --pv-amber: #b45309;
      --pv-red:   #e11d48;
      --pv-dim:   #b6bdcc;
      --pv-grad-1:     #f6f7f9;
      --pv-grad-pre-1: #eef1f6;
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
  }
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
    .top-nav-email { max-width: 22vw; }
  }
  .top-nav-email {
    color: var(--pv-muted); font-size: 12px; max-width: 28vw;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
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
      : `<header>
  <span class="brand">
    <svg class="brand-logo" width="20" height="20" viewBox="0 0 100 100" aria-hidden="true">${BRAND_MARK_SVG_BODY}</svg>
    <span class="brand-name">Pane</span>
  </span>
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
        // window.pane.downloadBlob() but never reaches the disk. `allow-popups`
        // is intentionally NOT included; only the in-tab download is enabled.
        `<iframe id="frame" sandbox="allow-scripts allow-forms allow-downloads" src="${htmlEscape(args.iframeContentUrl)}"></iframe>`
  }
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
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0e14" media="(prefers-color-scheme: dark)">
<title>Pane — ${tabTitle}</title>
<link rel="icon" type="image/svg+xml" href="${BRAND_FAVICON_HREF}">
<style>
  /* Standalone error/closed page. Same --pv-* token model as the viewer shell
     so dark stays byte-identical and light follows the device. */
  :root {
    color-scheme: light dark;
    --pv-bg:         #0b0e14;
    --pv-hairline:   #1f2633;
    --pv-ink:        #d7dee9;
    --pv-ink-strong: #e7ecf3;
    --pv-muted:      #8a93a6;
    --pv-green:      #7CE3B1;
    --pv-grad-1:     #10141d;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --pv-bg:         #ffffff;
      --pv-hairline:   #e4e7ee;
      --pv-ink:        #1a2030;
      --pv-ink-strong: #1a2030;
      --pv-muted:      #56607a;
      --pv-green:      #059669;
      --pv-grad-1:     #f6f7f9;
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
  }
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
  <span class="brand">
    <svg class="brand-logo" width="20" height="20" viewBox="0 0 100 100" aria-hidden="true">${BRAND_MARK_SVG_BODY}</svg>
    <span class="brand-name">Pane</span>
  </span>
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
