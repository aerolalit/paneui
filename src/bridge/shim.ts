// The `pane.*` shim. Inlined verbatim into the wrapped artifact page (see
// `src/bridge/routes.ts`) under a CSP nonce. The shim is the artifact's only
// outbound channel; it talks to the parent shell via postMessage, and the
// shell holds the token and the WebSocket connection.
//
// Wire format mirrors docs/architecture/phase-3-human-side.md:
//   iframe -> shell: { __pane:1, v:1, kind:"ready" | "emit", ... }
//   shell  -> iframe: { __pane:1, v:1, kind:"init" | "event" | "ack" | "error", ... }
//
// Keep this string self-contained. No imports, no external symbols, no
// `</script>` sequences (CSP nonce keeps inline-script execution safe, but a
// stray closing tag would prematurely end the wrapping <script>).
export const PANE_SHIM_JS = `(function () {
  var handlers = new Map();              // type -> Set<handler>
  var pendingEmits = new Map();          // correlation_id -> { resolve, reject, timer }
  var stateEvents = [];                  // SerializedEvent[]
  var stateSubscribers = new Set();
  var lastByType = new Map();            // type -> SerializedEvent
  var schema = null;
  var sessionId = null;
  var nextCorr = 1;
  // Shell origin is unknown until 'init' arrives — the very first 'ready'
  // post is sent with target "*" (no secrets) and outbound posts after init
  // are pinned to the shell origin learnt from the handshake.
  var shellOrigin = "*";

  function notifyState() {
    stateSubscribers.forEach(function (fn) {
      try { fn(); } catch (e) {}
    });
  }

  function ingest(ev) {
    stateEvents.push(ev);
    lastByType.set(ev.type, ev);
    notifyState();
    var hs = handlers.get(ev.type);
    if (hs) {
      hs.forEach(function (h) { try { h(ev); } catch (e) {} });
    }
  }

  var state = Object.freeze({
    get events() { return stateEvents.slice(); },
    last: function (type) {
      if (type === undefined) return stateEvents.length ? stateEvents[stateEvents.length - 1] : undefined;
      return lastByType.get(type);
    },
    subscribe: function (fn) {
      stateSubscribers.add(fn);
      return function () { stateSubscribers.delete(fn); };
    }
  });

  function on(type, handler) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    var set = handlers.get(type);
    set.add(handler);
    return function () { set.delete(handler); };
  }

  function emit(type, data, opts) {
    var corr = "c" + (nextCorr++);
    var frame = {
      __pane: 1, v: 1, kind: "emit",
      correlation_id: corr,
      type: String(type),
      data: data == null ? {} : data
    };
    if (opts && typeof opts === "object") {
      if (typeof opts.causationId === "string") frame.causation_id = opts.causationId;
      if (typeof opts.idempotencyKey === "string") frame.idempotency_key = opts.idempotencyKey;
    }
    parent.postMessage(frame, shellOrigin);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (pendingEmits.has(corr)) {
          pendingEmits.delete(corr);
          reject(new Error("emit timeout"));
        }
      }, 30000);
      pendingEmits.set(corr, { resolve: resolve, reject: reject, timer: timer });
    });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || typeof m !== "object" || m.__pane !== 1 || m.v !== 1) return;

    if (m.kind === "init") {
      sessionId = m.payload && m.payload.session_id;
      schema = m.payload && m.payload.schema;
      if (m.payload && typeof m.payload.shell_origin === "string") {
        shellOrigin = m.payload.shell_origin;
      }
      // Replay each event through the normal ingest path so handlers
      // registered before init still fire for historical events. Callers
      // that registered pane.on(type, fn) on script-load reasonably expect
      // the full stream, not only post-init events.
      var replay = (m.payload && m.payload.replay) || [];
      for (var i = 0; i < replay.length; i++) {
        ingest(replay[i]);
      }
      return;
    }
    if (m.kind === "event") {
      if (m.payload) ingest(m.payload);
      return;
    }
    if (m.kind === "ack") {
      var cid = m.correlation_id;
      if (cid && pendingEmits.has(cid)) {
        var p = pendingEmits.get(cid);
        pendingEmits.delete(cid);
        clearTimeout(p.timer);
        p.resolve({ id: m.event_id, deduped: !!m.deduped });
      }
      return;
    }
    if (m.kind === "error") {
      var ecid = m.correlation_id;
      if (ecid && pendingEmits.has(ecid)) {
        var pe = pendingEmits.get(ecid);
        pendingEmits.delete(ecid);
        clearTimeout(pe.timer);
        var err = new Error((m.error && m.error.message) || (m.error && m.error.code) || "emit failed");
        if (m.error) {
          err.code = m.error.code;
          err.details = m.error.details;
        }
        pe.reject(err);
      }
      return;
    }
  });

  window.pane = Object.freeze({ emit: emit, on: on, state: state });

  function announceReady() {
    parent.postMessage({ __pane: 1, v: 1, kind: "ready" }, "*");
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announceReady);
  } else {
    announceReady();
  }
})();`;
