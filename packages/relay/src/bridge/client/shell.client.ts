// The shell IIFE: runs in the participant's browser at /s/:token. Holds the
// WebSocket connection, owns the participant token (lives only in the shell,
// never reaches the iframe), and proxies the postMessage protocol between the
// sandboxed iframe (which runs the agent's artifact + the shim) and the WS.
//
// Config is delivered via a sibling `<script type="application/json" id="pane-cfg">`
// block emitted by routes.ts, NOT via template interpolation into this JS source.
// That keeps the only attack surface in routes.ts (which already neutralises
// `</script>` in the JSON via JSON.stringify behaviour for `<` inside strings).
//
// `export {}` makes this a module (needed for TS file scoping). The relay's
// loadClient() strips it before inlining — `export` is a SyntaxError in the
// classic <script> the file is injected into.
export {};

interface ShellCfg {
  sessionId: string;
  schema: unknown;
  token: string;
  wsUrl: string;
  isClosed: boolean;
}

interface SerializedEvent {
  id: string;
  type: string;
  data: unknown;
  [k: string]: unknown;
}

(function () {
  const cfgEl = document.getElementById("pane-cfg");
  if (!cfgEl || !cfgEl.textContent) return;
  const CFG: ShellCfg = JSON.parse(cfgEl.textContent);

  const dot = document.getElementById("dot")!;
  const statusEl = document.getElementById("status")!;
  const frame = document.getElementById("frame") as HTMLIFrameElement | null;
  let iframeReady = false;
  let replayDone = false;
  const replayBuffer: SerializedEvent[] = [];
  let lastEventId = 0;
  let ws: WebSocket | null = null;
  let backoff = 1000;

  function setStatus(t: string, cls?: "up" | "dn"): void {
    statusEl.textContent = t;
    dot.className = "dot" + (cls ? " " + cls : "");
  }

  // The iframe is sandboxed WITHOUT allow-same-origin, so it runs at the opaque
  // "null" origin. postMessage does NOT accept the literal string "null" as a
  // targetOrigin (it throws "Invalid target origin"), and an opaque origin has
  // no concrete value to pin to — so the only valid choice is "*".
  // This is not a broadcast: every post below targets `frame.contentWindow`
  // directly, so the message only ever reaches that one sandboxed iframe.
  // "*" only relaxes the recipient-origin check, which an opaque iframe would
  // fail anyway. The trust boundary is the sandbox + the contentWindow ref.
  const IFRAME_ORIGIN = "*";

  // Cap correlation_id everywhere it crosses the shell. The shim generates
  // short strings ("c1", "c2", ...). The cap exists to stop a buggy or
  // hostile artifact from forcing the relay to materialise a huge string
  // into every ack/error response.
  function validCid(v: unknown): v is string {
    return typeof v === "string" && v.length > 0 && v.length <= 128;
  }

  function sendIframeInit(): void {
    if (!iframeReady || !replayDone || !frame || !frame.contentWindow) return;
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

  function pushToIframe(ev: SerializedEvent): void {
    if (!iframeReady || !frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(
      { __pane: 1, v: 1, kind: "event", payload: ev },
      IFRAME_ORIGIN,
    );
  }

  function connect(): void {
    if (CFG.isClosed) return;
    setStatus("connecting...");
    let qs = "?token=" + encodeURIComponent(CFG.token);
    if (lastEventId > 0) qs += "&since=" + lastEventId;
    ws = new WebSocket(CFG.wsUrl + qs);

    ws.addEventListener("open", () => {
      backoff = 1000;
      setStatus("connected", "up");
    });

    ws.addEventListener("message", (evt: MessageEvent) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg && msg["kind"] === "system.replay.complete") {
        replayDone = true;
        sendIframeInit();
        return;
      }
      if (msg && msg["error"]) {
        if (validCid(msg["correlation_id"]) && iframeReady && frame && frame.contentWindow) {
          frame.contentWindow.postMessage({
            __pane: 1, v: 1, kind: "error",
            correlation_id: msg["correlation_id"],
            error: msg["error"],
          }, IFRAME_ORIGIN);
        }
        return;
      }
      if (msg && msg["ack"] !== undefined) {
        if (validCid(msg["correlation_id"]) && iframeReady && frame && frame.contentWindow) {
          frame.contentWindow.postMessage({
            __pane: 1, v: 1, kind: "ack",
            correlation_id: msg["correlation_id"],
            event_id: msg["ack"],
            deduped: !!msg["deduped"],
          }, IFRAME_ORIGIN);
        }
        return;
      }
      if (msg && msg["id"]) {
        // TODO(perf,phase-4): event ids are stringified on the wire; here we
        // coerce back to Number, which silently loses precision above 2^53.
        // Tracked alongside issue #23 (Postgres @db.BigInt migration).
        const n = Number(msg["id"]);
        if (isFinite(n) && n > lastEventId) lastEventId = n;
        if (!replayDone) {
          replayBuffer.push(msg as unknown as SerializedEvent);
        } else {
          pushToIframe(msg as unknown as SerializedEvent);
        }
      }
    });

    ws.addEventListener("close", () => {
      setStatus("reconnecting in " + Math.round(backoff / 1000) + "s...", "dn");
      setTimeout(() => {
        backoff = Math.min(backoff * 2, 30000);
        connect();
      }, backoff);
    });

    ws.addEventListener("error", () => {
      // close handler retries
    });
  }

  window.addEventListener("message", (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const m = e.data;
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
      const replyError = (code: string, message: string): void => {
        if (!validCid(m.correlation_id) || !frame || !frame.contentWindow) return;
        frame.contentWindow.postMessage({
          __pane: 1, v: 1, kind: "error",
          correlation_id: m.correlation_id,
          error: { code, message },
        }, IFRAME_ORIGIN);
      };
      if (typeof m.type !== "string" || !m.type.length || m.type.length > 64) {
        replyError("invalid_request", "type must be a non-empty string within 64 chars");
        return;
      }
      const out: Record<string, unknown> = {
        type: m.type,
        data: m.data,
      };
      if (typeof m.causation_id === "string" && m.causation_id.length <= 64) {
        out["causation_id"] = m.causation_id;
      }
      if (typeof m.idempotency_key === "string" && m.idempotency_key.length <= 128) {
        out["idempotency_key"] = m.idempotency_key;
      }
      if (validCid(m.correlation_id)) out["correlation_id"] = m.correlation_id;
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
