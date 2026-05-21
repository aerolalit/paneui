import { Hono, type Context } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import { hashKey } from "../keys.js";
import type { AppEnv } from "../http/env.js";
import { errors, ApiError } from "../http/errors.js";
import { prefersHtml } from "../http/accept.js";
import { agentCount } from "../ws/presence.js";
import type { EventSchema } from "../types.js";

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
  // The client TS files are modules (`export {}` for file scoping + the shim's
  // `declare global`), but they're injected inline as a classic <script>, where
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
const SHIM_JS = loadClient("shim.client.js");
const SHELL_JS = loadClient("shell.client.js");

function publicWsBase(config: Config): string {
  const u = new URL(config.publicUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/$/, "");
}

// The Pane brand mark, inlined as an SVG data URI for the browser tab.
// Inlining (vs. /favicon.ico) avoids an extra HTTP round-trip on every page
// load and keeps the relay deployment a single binary with no static-asset
// directory. The same shape is rendered visually in the header SVG below.
// Both the shell's CSP (img-src 'self' data:) and the error page's CSP
// (img-src 'self' data:) explicitly allow the data: scheme, so the icon
// loads under both surfaces.
const BRAND_FAVICON_HREF =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20100%20100%22%3E%3Crect%20width%3D%22100%22%20height%3D%22100%22%20rx%3D%2222%22%20fill%3D%22%230f172a%22%2F%3E%3Ccircle%20cx%3D%2262%22%20cy%3D%2258%22%20r%3D%2217%22%20fill%3D%22%2322d3ee%22%2F%3E%3Crect%20x%3D%2220%22%20y%3D%2226%22%20width%3D%2240%22%20height%3D%2232%22%20rx%3D%2210%22%20fill%3D%22%230f172a%22%2F%3E%3Crect%20x%3D%2224%22%20y%3D%2230%22%20width%3D%2232%22%20height%3D%2224%22%20rx%3D%227%22%20fill%3D%22%23a78bfa%22%2F%3E%3Ccircle%20cx%3D%2233.5%22%20cy%3D%2242%22%20r%3D%223.4%22%20fill%3D%22%230f172a%22%2F%3E%3Ccircle%20cx%3D%2246.5%22%20cy%3D%2242%22%20r%3D%223.4%22%20fill%3D%22%230f172a%22%2F%3E%3C%2Fsvg%3E";

// Belt-and-braces alongside the iframe sandbox. Disables every powerful API the
// browser exposes by default. Listed explicitly rather than `*=()` because the
// `Permissions-Policy` header has no "deny-all" shorthand.
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "battery=()",
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

async function loadByToken(prisma: PrismaClient, token: string) {
  if (!TOKEN_RX.test(token)) throw errors.notFound();
  const participant = await prisma.participant.findUnique({
    where: { tokenHash: hashKey(token) },
  });
  if (!participant || participant.revokedAt) throw errors.notFound();
  const session = await prisma.session.findUnique({
    where: { id: participant.sessionId },
    include: { artifactVersion: true },
  });
  if (!session) throw errors.notFound();
  return { participant, session };
}

// The shell shows an "agent presence" pill. Presence is LIVE runtime state,
// so it is computed from three present-tense signals — NOT by replaying the
// persisted `system.participant.*` log (a `left` event can be lost, which
// would leave a stale `joined` claiming an agent is connected forever):
//  1) agentLive        — an agent WebSocket is open on this session right now.
//  2) agentLastEventAt — the most recent agent-authored Event's timestamp.
//  3) agentLastUsedAt  — the owning agent's last authenticated request.
// Shared by the `/:token` route (seeds the shell config once) and the
// `/:token/presence` route (the shell polls this to keep the pill fresh) so
// the two never diverge.
interface AgentPresence {
  agentLive: boolean;
  agentLastEventAt: string | null;
  agentLastUsedAt: string | null;
}

async function computeAgentPresence(
  prisma: PrismaClient,
  session: {
    id: string;
    agentId: string;
  },
): Promise<AgentPresence> {
  const agent = await prisma.agent.findUnique({
    where: { id: session.agentId },
    select: { lastUsedAt: true },
  });
  const agentLastUsedAt = agent?.lastUsedAt
    ? agent.lastUsedAt.toISOString()
    : null;

  const lastAgentEvent = await prisma.event.findFirst({
    where: { sessionId: session.id, authorKind: "agent" },
    orderBy: { ts: "desc" },
    select: { ts: true },
  });
  const agentLastEventAt = lastAgentEvent
    ? lastAgentEvent.ts.toISOString()
    : null;

  const agentLive = (await agentCount(session.id)) > 0;

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
    loaded = await loadByToken(prisma, token);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      return humanOrJsonError(c, err);
    }
    throw err;
  }
  const { session } = loaded;

  // Live agent-presence facts that SEED the shell's pill — see
  // computeAgentPresence. The shell then keeps them fresh by polling
  // /:token/presence (a polling agent never opens a WebSocket, so the seed
  // would otherwise go stale within ~30s).
  const { agentLive, agentLastEventAt, agentLastUsedAt } =
    await computeAgentPresence(prisma, session);

  const isClosed =
    session.status !== "open" || session.expiresAt.getTime() < Date.now();
  const wsUrl = publicWsBase(config) + "/v1/sessions/" + session.id + "/stream";
  const schema = session.artifactVersion.eventSchema as unknown as EventSchema;
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
      // connection to /v1/sessions/:id/stream. Allow the relay's own ws origin.
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

  return c.body(
    renderShell({
      nonce,
      token,
      sessionId: session.id,
      schema,
      inputData: session.inputData ?? null,
      wsUrl,
      isClosed,
      agentLive,
      agentLastEventAt,
      agentLastUsedAt,
      title: session.title,
    }),
  );
});

bridge.get("/:token/content", async (c) => {
  const prisma = c.get("prisma");
  const token = c.req.param("token");
  if (!token) {
    return humanOrJsonError(c, errors.notFound());
  }
  let loaded: Awaited<ReturnType<typeof loadByToken>>;
  try {
    loaded = await loadByToken(prisma, token);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      return humanOrJsonError(c, err);
    }
    throw err;
  }
  const { session } = loaded;

  // Gate the artifact body on the session being live. The shell page renders
  // a "closed" banner instead of the iframe, but a client that bookmarked
  // /content directly would otherwise still receive the artifact (and any
  // sensitive data baked into it) until the participant is revoked.
  if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
    return humanOrJsonError(c, errors.gone());
  }

  let artifactBody: string;
  if (session.artifactVersion.artifactType === "html-inline") {
    artifactBody = session.artifactVersion.artifactSource;
  } else {
    // html-ref is rejected at POST /v1/sessions in this release, so no new
    // session reaches here with that type. Kept as defence-in-depth for any
    // pre-existing row; fetch + cache support is deferred to a later phase.
    artifactBody = "<!-- artifact.type=html-ref is not implemented in v1 -->";
  }

  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      // 'unsafe-inline' only — no nonce. CSP3 browsers ignore 'unsafe-inline'
      // when a nonce is present, which would block the agent's own inline
      // <script> tags inside artifactBody. The shim is just another inline
      // script under the same sandbox; both are covered by 'unsafe-inline'.
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data: blob:",
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

// Lightweight presence endpoint. The shell polls this every ~10s so the
// agent-presence pill reflects a polling agent (one that monitors via
// `pane state` HTTP polls and never opens a WebSocket) — its `lastUsedAt`
// keeps advancing server-side but the page-load config seed cannot see it.
//
// Trust model: the URL token IS the auth, identical to the shell page
// (`/:token`) it accompanies. No extra credential is required. The body is a
// tiny JSON object and is cheap to recompute on every poll.
bridge.get("/:token/presence", async (c) => {
  const prisma = c.get("prisma");
  const token = c.req.param("token");
  if (!token) throw errors.notFound();
  const { session } = await loadByToken(prisma, token);

  const presence = await computeAgentPresence(prisma, session);

  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(JSON.stringify(presence));
});

interface ShellArgs {
  nonce: string;
  token: string;
  sessionId: string;
  schema: EventSchema;
  // The session's per-instance input_data (validated against the artifact
  // version's input_schema at create time). Threaded through the shell config
  // and the init frame so the artifact can read it as `window.pane.inputData`.
  inputData: unknown;
  wsUrl: string;
  isClosed: boolean;
  // Live agent-presence facts, computed at request time. See the /s/:token
  // handler for what each signal means.
  agentLive: boolean;
  agentLastEventAt: string | null;
  agentLastUsedAt: string | null;
  // Agent-supplied (or Artifact.name-resolved) per-session title. Validated at
  // session create — non-empty, ≤80 chars, no control chars — but still
  // untrusted at this point; HTML-escaped into <title> at render time.
  title: string;
}

function renderShell(args: ShellArgs): string {
  const cfg = {
    sessionId: args.sessionId,
    schema: args.schema,
    inputData: args.inputData,
    token: args.token,
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
<title>${htmlEscape(args.title)}</title>
<link rel="icon" type="image/svg+xml" href="${BRAND_FAVICON_HREF}">
<style nonce="${args.nonce}">
  html, body { height: 100%; margin: 0; }
  body {
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0b0e14; color: #d7dee9;
    display: flex; flex-direction: column;
  }
  header {
    padding: 9px 14px; font-size: 13px;
    display: flex; align-items: center; gap: 10px;
    background: linear-gradient(180deg, #10141d 0%, #0b0e14 100%);
    border-bottom: 1px solid #1f2633;
  }
  .brand {
    display: inline-flex; align-items: center; gap: 7px;
    user-select: none;
  }
  .brand-logo { display: block; flex: none; }
  .brand-name {
    font-weight: 600; font-size: 14px; letter-spacing: 0.2px;
    color: #e7ecf3;
  }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px 3px 8px; border-radius: 999px;
    background: #141a26; border: 1px solid #1f2633;
  }
  .pill-icon { display: block; flex: none; color: #8a93a6; }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #5b6477; flex: none;
  }
  .dot.up {
    background: #7CE3B1;
    animation: pulse 2s ease-in-out infinite;
  }
  .dot.dn { background: #f07178; }
  .dot.amber { background: #f7c66a; }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(124, 227, 177, 0.45); }
    50%      { box-shadow: 0 0 0 4px rgba(124, 227, 177, 0); }
  }
  .info { color: #8a93a6; }
  .spacer { flex: 1; }
  iframe { border: 0; flex: 1; width: 100%; background: white; display: block; }
  .closed {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: #8a93a6; font-size: 14px;
  }
</style>
</head>
<body>
<header>
  <span class="brand">
    <svg class="brand-logo" width="20" height="20" viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="22" fill="#0f172a"/>
      <circle cx="62" cy="58" r="17" fill="#22d3ee"/>
      <rect x="20" y="26" width="40" height="32" rx="10" fill="#0f172a"/>
      <rect x="24" y="30" width="32" height="24" rx="7" fill="#a78bfa"/>
      <circle cx="33.5" cy="42" r="3.4" fill="#0f172a"/>
      <circle cx="46.5" cy="42" r="3.4" fill="#0f172a"/>
    </svg>
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
    <span id="agent-status" class="info">${args.isClosed ? "session closed" : "no agent yet"}</span>
  </span>
</header>
${
  args.isClosed
    ? `<div class="closed">This session is closed. It cannot accept new events.</div>`
    : `<iframe id="frame" sandbox="allow-scripts allow-forms" src="/s/${args.token}/content"></iframe>`
}
<script type="application/json" id="pane-cfg">${cfgJson}</script>
<script nonce="${args.nonce}">${SHELL_JS}</script>
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
// participant | session row deleted" — all three look identical in the
// rendered page on purpose, so the bridge isn't a participant-token
// enumeration oracle. 410 covers TTL-expired and explicitly-closed sessions
// reached through the /content sub-route.
function errorPageFor(err: ApiError): string {
  const copy: ErrorPageCopy =
    err.status === 410
      ? {
          tabTitle: "Closed",
          headline: "This pane has been closed",
          body: "The session has expired or been closed by the agent. Ask for a new link if you still need to act.",
        }
      : {
          tabTitle: "Not found",
          headline: "This pane link isn't valid",
          body: "The link may be mistyped, or the session may have been cleaned up. Ask the agent for a fresh one.",
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
<title>Pane — ${tabTitle}</title>
<link rel="icon" type="image/svg+xml" href="${BRAND_FAVICON_HREF}">
<style>
  html, body { height: 100%; margin: 0; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0b0e14; color: #d7dee9;
    display: flex; flex-direction: column;
  }
  header {
    padding: 9px 14px; font-size: 13px;
    display: flex; align-items: center; gap: 10px;
    background: linear-gradient(180deg, #10141d 0%, #0b0e14 100%);
    border-bottom: 1px solid #1f2633;
  }
  .brand {
    display: inline-flex; align-items: center; gap: 7px;
    user-select: none;
  }
  .brand-logo { display: block; flex: none; }
  .brand-name {
    font-weight: 600; font-size: 14px; letter-spacing: 0.2px;
    color: #e7ecf3;
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
    color: #e7ecf3; letter-spacing: 0.2px;
  }
  p { margin: 0 0 18px; color: #8a93a6; }
  a {
    color: #7CE3B1; text-decoration: none;
    border-bottom: 1px solid rgba(124, 227, 177, 0.3);
  }
  a:hover { border-bottom-color: #7CE3B1; }
</style>
</head>
<body>
<header>
  <span class="brand">
    <svg class="brand-logo" width="20" height="20" viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="22" fill="#0f172a"/>
      <circle cx="62" cy="58" r="17" fill="#22d3ee"/>
      <rect x="20" y="26" width="40" height="32" rx="10" fill="#0f172a"/>
      <rect x="24" y="30" width="32" height="24" rx="7" fill="#a78bfa"/>
      <circle cx="33.5" cy="42" r="3.4" fill="#0f172a"/>
      <circle cx="46.5" cy="42" r="3.4" fill="#0f172a"/>
    </svg>
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
