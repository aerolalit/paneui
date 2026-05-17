import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import { hashKey } from "../keys.js";
import type { AppEnv } from "../http/env.js";
import { errors } from "../http/errors.js";
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

// Participant tokens are `randomBytes(32).toString("base64url")` in keys.ts —
// exactly 43 chars, base64url alphabet. Reject on shape before we hash so
// pathological inputs (10 MB strings, control chars) can't force SHA-256 work
// and a guaranteed-miss DB lookup. A real rate limiter belongs at the edge
// (tracked in issue #6); this is the in-app first line of defence.
const TOKEN_RX = /^[A-Za-z0-9_-]{40,50}$/;

async function loadByToken(prisma: PrismaClient, token: string) {
  if (!TOKEN_RX.test(token)) throw errors.notFound();
  const participant = await prisma.participant.findUnique({
    where: { tokenHash: hashKey(token) },
  });
  if (!participant || participant.revokedAt) throw errors.notFound();
  const session = await prisma.session.findUnique({
    where: { id: participant.sessionId },
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

  const agentLive = agentCount(session.id) > 0;

  return { agentLive, agentLastEventAt, agentLastUsedAt };
}

bridge.get("/:token", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const token = c.req.param("token");
  if (!token) throw errors.notFound();
  const { session } = await loadByToken(prisma, token);

  // Live agent-presence facts that SEED the shell's pill — see
  // computeAgentPresence. The shell then keeps them fresh by polling
  // /:token/presence (a polling agent never opens a WebSocket, so the seed
  // would otherwise go stale within ~30s).
  const { agentLive, agentLastEventAt, agentLastUsedAt } =
    await computeAgentPresence(prisma, session);

  const isClosed =
    session.status !== "open" || session.expiresAt.getTime() < Date.now();
  const wsUrl = publicWsBase(config) + "/v1/sessions/" + session.id + "/stream";
  const schema = session.eventSchema as unknown as EventSchema;
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
      wsUrl,
      isClosed,
      agentLive,
      agentLastEventAt,
      agentLastUsedAt,
    }),
  );
});

bridge.get("/:token/content", async (c) => {
  const prisma = c.get("prisma");
  const token = c.req.param("token");
  if (!token) throw errors.notFound();
  const { session } = await loadByToken(prisma, token);

  // Gate the artifact body on the session being live. The shell page renders
  // a "closed" banner instead of the iframe, but a client that bookmarked
  // /content directly would otherwise still receive the artifact (and any
  // sensitive data baked into it) until the participant is revoked.
  if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  let artifactBody: string;
  if (session.artifactType === "html-inline") {
    artifactBody = session.artifactSource;
  } else {
    // html-ref: v1 stub. Fetch + cache support is deferred (issue #24).
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
  wsUrl: string;
  isClosed: boolean;
  // Live agent-presence facts, computed at request time. See the /s/:token
  // handler for what each signal means.
  agentLive: boolean;
  agentLastEventAt: string | null;
  agentLastUsedAt: string | null;
}

function renderShell(args: ShellArgs): string {
  const cfg = {
    sessionId: args.sessionId,
    schema: args.schema,
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
<title>Pane Session</title>
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
    <svg class="brand-logo" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="none" stroke="#2b3445" stroke-width="1.5"/>
      <rect x="4.5" y="4.5" width="5" height="5" rx="1" fill="#7CE3B1"/>
      <rect x="10.5" y="4.5" width="5" height="5" rx="1" fill="#4a5670"/>
      <rect x="4.5" y="10.5" width="5" height="5" rx="1" fill="#4a5670"/>
      <rect x="10.5" y="10.5" width="5" height="5" rx="1" fill="#4a5670"/>
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
    : `<iframe id="frame" sandbox="allow-scripts" src="/s/${args.token}/content"></iframe>`
}
<script type="application/json" id="pane-cfg">${cfgJson}</script>
<script nonce="${args.nonce}">${SHELL_JS}</script>
</body>
</html>`;
}

export default bridge;
