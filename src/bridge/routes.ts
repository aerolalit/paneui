import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import config from "../config.js";
import prisma from "../db.js";
import { hashKey } from "../keys.js";
import { errors } from "../http/errors.js";
import { PANE_SHIM_JS } from "./shim.js";
import type { EventSchema } from "../types.js";

const bridge = new Hono();

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

// Safe inline JSON for embedding inside <script>. Neutralises two breakout
// vectors in the HTML script-data parser:
//   - `</`     can start a `</script>` end-tag.
//   - `<!--`   enters "script data double escaped" state, after which a stray
//              `</script>` further down can confuse parsing.
// (`eventSchema` is operator-supplied today, but the cost of escaping is zero.)
function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
}

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
  const nonce = randomBytes(16).toString("base64url");
  const wsUrl = publicWsBase() + "/v1/sessions/" + session.id + "/stream";
  const schema = session.eventSchema as unknown as EventSchema;

  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // Nonce-only on script/style: dropping 'self' means another same-origin
      // endpoint that ever serves attacker-controlled content can't XSS the
      // shell. The shell has exactly one nonced <script> + one nonced <style>.
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
      "connect-src 'self'",
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

  const html = renderShell({
    nonce,
    token,
    sessionId: session.id,
    schema,
    wsUrl,
    isClosed,
  });
  return c.body(html);
});

bridge.get("/:token/content", async (c) => {
  const token = c.req.param("token");
  if (!token) throw errors.notFound();
  const { session } = await loadByToken(token);

  // Gate the artifact body on the session being live. The shell page renders
  // a "closed" banner instead of the iframe (see L70), but a client that
  // bookmarked /content directly would otherwise still receive the artifact
  // (and any sensitive data baked into it) until the participant is revoked.
  // Mirrors the WS upgrade behaviour.
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
<script>${PANE_SHIM_JS}</script>
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
  const cfgJson = safeJson(cfg);
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
<script nonce="${args.nonce}">
(function () {
  var CFG = ${cfgJson};
  var dot = document.getElementById("dot");
  var status = document.getElementById("status");
  var frame = document.getElementById("frame");
  var iframeReady = false;
  var replayDone = false;
  var replayBuffer = [];
  var lastEventId = 0;
  var ws = null;
  var backoff = 1000;

  function setStatus(t, cls) {
    status.textContent = t;
    dot.className = "dot" + (cls ? " " + cls : "");
  }

  // The iframe is sandboxed WITHOUT allow-same-origin, so its document.origin
  // is the opaque "null" origin once it executes. To get strict targetOrigin
  // matching (instead of using "*" and accepting any contentWindow), we pin
  // every shell->iframe post to "null".
  var IFRAME_ORIGIN = "null";

  // Cap correlation_id everywhere it crosses the shell. The shim generates
  // short strings ("c1", "c2", ...), so 128 chars is loose; the cap exists to
  // stop a buggy or hostile artifact from forcing the relay to materialise a
  // huge string into every ack/error response.
  function validCid(v) {
    return typeof v === "string" && v.length > 0 && v.length <= 128;
  }

  function sendIframeInit() {
    if (!iframeReady || !replayDone || !frame) return;
    frame.contentWindow.postMessage({
      __pane: 1, v: 1, kind: "init",
      payload: {
        session_id: CFG.sessionId,
        schema: CFG.schema,
        replay: replayBuffer.slice(),
        shell_origin: window.location.origin,
      },
    }, IFRAME_ORIGIN);
  }

  function pushToIframe(ev) {
    if (!iframeReady || !frame) return;
    frame.contentWindow.postMessage({ __pane: 1, v: 1, kind: "event", payload: ev }, IFRAME_ORIGIN);
  }

  function connect() {
    if (CFG.isClosed) return;
    setStatus("connecting...");
    var qs = "?token=" + encodeURIComponent(CFG.token);
    if (lastEventId > 0) qs += "&since=" + lastEventId;
    ws = new WebSocket(CFG.wsUrl + qs);

    ws.addEventListener("open", function () {
      backoff = 1000;
      setStatus("connected", "up");
    });

    ws.addEventListener("message", function (evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (msg && msg.kind === "system.replay.complete") {
        replayDone = true;
        sendIframeInit();
        return;
      }
      if (msg && msg.error) {
        if (validCid(msg.correlation_id) && iframeReady && frame) {
          frame.contentWindow.postMessage({
            __pane: 1, v: 1, kind: "error",
            correlation_id: msg.correlation_id,
            error: msg.error,
          }, IFRAME_ORIGIN);
        }
        return;
      }
      if (msg && msg.ack !== undefined) {
        if (validCid(msg.correlation_id) && iframeReady && frame) {
          frame.contentWindow.postMessage({
            __pane: 1, v: 1, kind: "ack",
            correlation_id: msg.correlation_id,
            event_id: msg.ack,
            deduped: !!msg.deduped,
          }, IFRAME_ORIGIN);
        }
        return;
      }
      if (msg && msg.id) {
        // TODO(perf,phase-4): event ids are stringified on the wire; here we
        // coerce back to Number, which silently loses precision above 2^53.
        // Tracked alongside issue #23 (Postgres @db.BigInt migration).
        var n = Number(msg.id);
        if (isFinite(n) && n > lastEventId) lastEventId = n;
        if (!replayDone) {
          replayBuffer.push(msg);
        } else {
          pushToIframe(msg);
        }
      }
    });

    ws.addEventListener("close", function () {
      setStatus("reconnecting in " + Math.round(backoff / 1000) + "s...", "dn");
      setTimeout(function () {
        backoff = Math.min(backoff * 2, 30000);
        connect();
      }, backoff);
    });

    ws.addEventListener("error", function () {
      // close handler retries
    });
  }

  window.addEventListener("message", function (e) {
    if (!frame || e.source !== frame.contentWindow) return;
    var m = e.data;
    if (!m || typeof m !== "object" || m.__pane !== 1 || m.v !== 1) return;
    if (m.kind === "ready") {
      iframeReady = true;
      sendIframeInit();
      return;
    }
    if (m.kind === "emit") {
      // The shim always attaches correlation_id, so any failure path here
      // MUST reply with a synthetic error frame — otherwise pane.emit()'s
      // Promise sits hanging until the 30s timeout fires.
      function replyError(code, message) {
        if (!validCid(m.correlation_id) || !frame) return;
        frame.contentWindow.postMessage({
          __pane: 1, v: 1, kind: "error",
          correlation_id: m.correlation_id,
          error: { code: code, message: message },
        }, IFRAME_ORIGIN);
      }
      if (typeof m.type !== "string" || !m.type.length || m.type.length > 64) {
        replyError("invalid_request", "type must be a non-empty string within 64 chars");
        return;
      }
      var out = {
        type: m.type,
        data: m.data,
      };
      if (typeof m.causation_id === "string" && m.causation_id.length <= 64) {
        out.causation_id = m.causation_id;
      }
      if (typeof m.idempotency_key === "string" && m.idempotency_key.length <= 128) {
        out.idempotency_key = m.idempotency_key;
      }
      if (validCid(m.correlation_id)) out.correlation_id = m.correlation_id;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(out));
      } else {
        replyError("disconnected", "WebSocket is not open");
      }
      return;
    }
  });

  connect();
})();
</script>
</body>
</html>`;
}

export default bridge;
