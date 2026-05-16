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
  // ISO timestamp of the owning agent's last authenticated request, or null if
  // the agent has never touched the relay. Seeds the agent-presence pill; the
  // replayed `system.participant.*` events then keep presence live.
  agentLastActiveAt: string | null;
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
  const agentDot = document.getElementById("agent-dot")!;
  const agentStatusEl = document.getElementById("agent-status")!;
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

  // --- Agent presence -------------------------------------------------------
  // Two independent signals combine into one honest label:
  //  1) liveAgents — ids of agent-kind participants currently joined. Driven by
  //     `system.participant.joined`/`left` events (replayed AND live). A
  //     non-empty set means an agent stream is open right now.
  //  2) lastAgentActiveMs — the most recent moment an agent touched the
  //     session. Seeded from cfg.agentLastActiveAt, bumped to now() whenever an
  //     agent-authored event arrives.
  // "agent active" is claimed ONLY when liveAgents is non-empty.
  const RECENT_WINDOW_MS = 5 * 60 * 1000;
  const liveAgents = new Set<string>();
  let lastAgentActiveMs: number | null = null;
  let sawAnyAgentActivity = false;
  if (CFG.agentLastActiveAt) {
    const t = Date.parse(CFG.agentLastActiveAt);
    if (isFinite(t)) {
      lastAgentActiveMs = t;
      sawAnyAgentActivity = true;
    }
  }

  function relTime(ms: number): string {
    const d = Math.max(0, Date.now() - ms);
    if (d < 10000) return "just now";
    if (d < 60000) return Math.floor(d / 1000) + "s ago";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    return Math.floor(d / 86400000) + "d ago";
  }

  function renderAgentPresence(): void {
    if (CFG.isClosed) {
      agentStatusEl.textContent = "session closed";
      agentDot.className = "dot";
      return;
    }
    if (liveAgents.size > 0) {
      agentStatusEl.textContent = "agent active";
      agentDot.className = "dot up";
      return;
    }
    if (lastAgentActiveMs !== null && Date.now() - lastAgentActiveMs <= RECENT_WINDOW_MS) {
      agentStatusEl.textContent = "agent active " + relTime(lastAgentActiveMs);
      agentDot.className = "dot amber";
      return;
    }
    agentStatusEl.textContent = sawAnyAgentActivity ? "agent away" : "no agent yet";
    agentDot.className = "dot";
  }

  // Fold a single event into agent-presence state. Called for replayed and live
  // events alike (the shell makes no distinction).
  function trackAgentPresence(ev: SerializedEvent): void {
    const author = (ev.data as { author?: { kind?: unknown; id?: unknown } } | null)?.author;
    if (ev.type === "system.participant.joined" || ev.type === "system.participant.left") {
      if (author && author.kind === "agent" && typeof author.id === "string") {
        if (ev.type === "system.participant.joined") liveAgents.add(author.id);
        else liveAgents.delete(author.id);
      }
      return;
    }
    // Any non-system event authored by an agent proves recent activity.
    const evAuthor = (ev as { author?: { kind?: unknown } }).author;
    if (evAuthor && evAuthor.kind === "agent") {
      lastAgentActiveMs = Date.now();
      sawAnyAgentActivity = true;
    }
  }

  renderAgentPresence();
  // "active 2m ago" must advance on its own even when no events arrive.
  setInterval(renderAgentPresence, 20000);

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
        // Fold every event (replayed or live) into agent-presence state, then
        // re-render the pill. Done before the iframe-buffering branch so a
        // fresh connection's replay reconstructs current presence immediately.
        trackAgentPresence(msg as unknown as SerializedEvent);
        renderAgentPresence();
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
