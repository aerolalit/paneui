import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../config.js";
import prisma from "../db.js";
import { hashKey } from "../keys.js";
import { errors } from "../http/errors.js";
import type { EventSchema } from "../types.js";

const bridge = new Hono();

// Compiled client bundles. Authored as real TS modules under
// src/bridge/client/*.ts and compiled by `tsc -p tsconfig.client.json` (which
// the `pre*` npm hooks run before dev/test/typecheck). Output lives at
// dist/client/*.js regardless of whether we're running tsx-from-source or
// node-from-dist, so we resolve a single absolute path from the project root.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function loadClient(name: string): string {
  let js = readFileSync(resolve(PROJECT_ROOT, "dist", "client", name), "utf8");
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

function publicWsBase(): string {
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

async function loadByToken(token: string) {
  if (!TOKEN_RX.test(token)) throw errors.notFound();
  const participant = await prisma.participant.findUnique({ where: { tokenHash: hashKey(token) } });
  if (!participant || participant.revokedAt) throw errors.notFound();
  const session = await prisma.session.findUnique({ where: { id: participant.sessionId } });
  if (!session) throw errors.notFound();
  return { participant, session };
}

bridge.get("/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) throw errors.notFound();
  const { session } = await loadByToken(token);

  const isClosed = session.status !== "open" || session.expiresAt.getTime() < Date.now();
  const wsUrl = publicWsBase() + "/v1/sessions/" + session.id + "/stream";
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
      `connect-src 'self' ${publicWsBase()}`,
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

  return c.body(renderShell({ nonce, token, sessionId: session.id, schema, wsUrl, isClosed }));
});

bridge.get("/:token/content", async (c) => {
  const token = c.req.param("token");
  if (!token) throw errors.notFound();
  const { session } = await loadByToken(token);

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

interface ShellArgs {
  nonce: string;
  token: string;
  sessionId: string;
  schema: EventSchema;
  wsUrl: string;
  isClosed: boolean;
}

function renderShell(args: ShellArgs): string {
  const cfg = {
    sessionId: args.sessionId,
    schema: args.schema,
    token: args.token,
    wsUrl: args.wsUrl,
    isClosed: args.isClosed,
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
    padding: 9px 14px; border-bottom: 1px solid #1f2633;
    display: flex; align-items: center; gap: 8px; font-size: 13px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #5b6477; }
  .dot.up { background: #7CE3B1; }
  .dot.dn { background: #f07178; }
  .info { color: #8a93a6; }
  iframe { border: 0; flex: 1; width: 100%; background: white; display: block; }
  .closed {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: #8a93a6; font-size: 14px;
  }
</style>
</head>
<body>
<header>
  <span id="dot" class="dot"></span>
  <span id="status" class="info">connecting...</span>
  <span class="info">${args.isClosed ? "&middot; session closed" : ""}</span>
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
