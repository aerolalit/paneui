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
  // Live agent-presence facts, computed by the relay at request time. These
  // SEED the agent-presence pill; the shell then keeps it live from events
  // received after `system.replay.complete` (see the presence section below).
  //  - agentLive: an agent WebSocket was open on this session at request time.
  //  - agentLastEventAt: ISO ts of the most recent agent-authored event.
  //  - agentLastUsedAt: ISO ts of the owning agent's last authenticated request.
  agentLive: boolean;
  agentLastEventAt: string | null;
  agentLastUsedAt: string | null;
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
  // Presence is LIVE runtime state. It is NOT reconstructed by replaying the
  // persisted `system.participant.joined`/`left` log — a `left` event is
  // written fire-and-forget by the relay and can be lost, which would leave a
  // stale `joined` claiming an agent is connected forever. So:
  //
  //  - Before `system.replay.complete`: trust ONLY the seed facts from CFG
  //    (agentLive / agentLastEventAt / agentLastUsedAt), which the relay
  //    computed from present-tense signals at request time.
  //  - After `system.replay.complete`: trust the live agent socket count that
  //    the relay stamps onto every participant.joined/left event as
  //    `data.agentCountLive`. Replayed (historical) events also carry that
  //    field, but its value reflected the past — so we IGNORE agentCountLive
  //    until replay completes, then read it from every live participant event.
  //
  // Two pieces of state drive the pill:
  //  1) agentLiveCount — number of agent sockets open right now. Seeded from
  //     CFG.agentLive, then kept exact from post-replay `agentCountLive`.
  //  2) lastAgentActiveMs — the most recent moment an agent touched the
  //     session (sent an event or pulled events). Seeded from the max of
  //     CFG.agentLastEventAt / agentLastUsedAt, bumped to now() on any live
  //     agent-authored event.
  const RECENT_WINDOW_MS = 5 * 60 * 1000;
  // Grace window: an agent monitor often reconnects in short `pane watch`
  // cycles (connect -> get event -> exit -> harness re-runs). The live socket
  // count flickers 1 -> 0 -> 1 between cycles. Without a grace period the pill
  // would flap green -> amber -> green. So once a live agent socket has been
  // seen, keep showing "agent active" (green) for this long after it drops —
  // brief reconnection gaps stay green; only a sustained absence falls to amber.
  const LIVE_GRACE_MS = 45 * 1000;
  let agentLiveCount = CFG.agentLive ? 1 : 0;
  // Timestamp of the most recent moment an agent socket was open. Set whenever
  // agentLiveCount is > 0; the grace window is measured from it.
  let lastAgentLiveMs: number | null = CFG.agentLive ? Date.now() : null;
  let lastAgentActiveMs: number | null = null;
  let sawAnyAgentActivity = false;
  for (const iso of [CFG.agentLastEventAt, CFG.agentLastUsedAt]) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (isFinite(t)) {
      if (lastAgentActiveMs === null || t > lastAgentActiveMs) lastAgentActiveMs = t;
      sawAnyAgentActivity = true;
    }
  }
  if (CFG.agentLive) sawAnyAgentActivity = true;

  // Relative time, scoped to the 5-minute RECENT_WINDOW — no buckets beyond
  // what that window can ever display.
  function relTime(ms: number): string {
    const d = Math.max(0, Date.now() - ms);
    if (d < 60000) return "just now";
    return Math.floor(d / 60000) + "m ago";
  }

  function renderAgentPresence(): void {
    if (CFG.isClosed) {
      agentStatusEl.textContent = "session closed";
      agentDot.className = "dot";
      return;
    }
    // Green while a socket is open, OR within the grace window after the last
    // one closed — so short reconnection gaps in an agent's monitor loop don't
    // flap the pill to amber.
    if (
      agentLiveCount > 0 ||
      (lastAgentLiveMs !== null && Date.now() - lastAgentLiveMs <= LIVE_GRACE_MS)
    ) {
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

  // Fold a single LIVE (post-replay-complete) event into presence state.
  // Replayed events are NOT passed here — historical participant events carry a
  // stale `agentCountLive` and a stale `joined` with no matching `left` would
  // corrupt the count.
  function trackLiveAgentPresence(ev: SerializedEvent): void {
    if (ev.type === "system.participant.joined" || ev.type === "system.participant.left") {
      // The relay stamps the exact current agent socket count onto every
      // participant event it broadcasts — trust it verbatim.
      const n = (ev.data as { agentCountLive?: unknown } | null)?.agentCountLive;
      if (typeof n === "number" && isFinite(n) && n >= 0) {
        agentLiveCount = n;
        if (n > 0) {
          sawAnyAgentActivity = true;
          // Stamp the moment a socket is confirmed open — the grace window
          // (see renderAgentPresence) is measured from this.
          lastAgentLiveMs = Date.now();
        }
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
        if (!replayDone) {
          // Replayed (historical) events do NOT update presence: a lost `left`
          // would leave a stale `joined` claiming an agent is connected. Live
          // presence comes only from CFG (seed) + post-replay events below.
          replayBuffer.push(msg as unknown as SerializedEvent);
        } else {
          // Live event — fold it into presence and re-render the pill.
          trackLiveAgentPresence(msg as unknown as SerializedEvent);
          renderAgentPresence();
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
