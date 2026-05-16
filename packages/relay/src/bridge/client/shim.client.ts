// The `pane.*` shim. Compiled (with the client tsconfig) to
// `dist/client/shim.client.js` and inlined verbatim into the wrapped artifact
// page by `src/bridge/routes.ts`.
//
// Wire format mirrors docs/architecture/phase-3-human-side.md:
//   iframe -> shell: { __pane:1, v:1, kind:"ready" | "emit", ... }
//   shell  -> iframe: { __pane:1, v:1, kind:"init" | "event" | "ack" | "error", ... }
//
// The whole module body is wrapped in an IIFE so it's safe to inline into a
// <script> tag (no top-level imports, no module scope leaks).

export {};

interface SerializedEvent {
  id: string;
  type: string;
  data: unknown;
  [k: string]: unknown;
}

interface EmitOpts {
  causationId?: string;
  idempotencyKey?: string;
}

interface PaneApi {
  emit(type: string, data?: unknown, opts?: EmitOpts): Promise<{ id: string; deduped: boolean }>;
  on(type: string, handler: (ev: SerializedEvent) => void): () => void;
  state: {
    readonly events: SerializedEvent[];
    last(type?: string): SerializedEvent | undefined;
    subscribe(fn: () => void): () => void;
  };
}

interface PendingEmit {
  resolve: (v: { id: string; deduped: boolean }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PaneError extends Error {
  code?: string;
  details?: unknown;
}

declare global {
  interface Window {
    pane: PaneApi;
  }
}

(function () {
  const handlers = new Map<string, Set<(ev: SerializedEvent) => void>>();
  const pendingEmits = new Map<string, PendingEmit>();
  const stateEvents: SerializedEvent[] = [];
  const stateSubscribers = new Set<() => void>();
  const lastByType = new Map<string, SerializedEvent>();
  let nextCorr = 1;
  // Shell origin is unknown until 'init' arrives — the very first 'ready'
  // post is sent with target "*" (no secrets) and outbound posts after init
  // are pinned to the shell origin learnt from the handshake.
  let shellOrigin: string = "*";

  function notifyState(): void {
    stateSubscribers.forEach((fn) => {
      try { fn(); } catch { /* swallow */ }
    });
  }

  function ingest(ev: SerializedEvent): void {
    stateEvents.push(ev);
    lastByType.set(ev.type, ev);
    notifyState();
    const hs = handlers.get(ev.type);
    if (hs) {
      hs.forEach((h) => { try { h(ev); } catch { /* swallow */ } });
    }
  }

  const state = Object.freeze({
    get events(): SerializedEvent[] { return stateEvents.slice(); },
    last(type?: string): SerializedEvent | undefined {
      if (type === undefined) {
        return stateEvents.length ? stateEvents[stateEvents.length - 1] : undefined;
      }
      return lastByType.get(type);
    },
    subscribe(fn: () => void): () => void {
      stateSubscribers.add(fn);
      return () => { stateSubscribers.delete(fn); };
    },
  });

  function on(type: string, handler: (ev: SerializedEvent) => void): () => void {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  function emit(
    type: string,
    data?: unknown,
    opts?: EmitOpts,
  ): Promise<{ id: string; deduped: boolean }> {
    const corr = "c" + (nextCorr++);
    const frame: Record<string, unknown> = {
      __pane: 1,
      v: 1,
      kind: "emit",
      correlation_id: corr,
      type: String(type),
      data: data == null ? {} : data,
    };
    if (opts && typeof opts === "object") {
      if (typeof opts.causationId === "string") frame["causation_id"] = opts.causationId;
      if (typeof opts.idempotencyKey === "string") frame["idempotency_key"] = opts.idempotencyKey;
    }
    parent.postMessage(frame, shellOrigin);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingEmits.has(corr)) {
          pendingEmits.delete(corr);
          reject(new Error("emit timeout"));
        }
      }, 30000);
      pendingEmits.set(corr, { resolve, reject, timer });
    });
  }

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.__pane !== 1 || m.v !== 1) return;

    if (m.kind === "init") {
      if (m.payload && typeof m.payload.shell_origin === "string") {
        shellOrigin = m.payload.shell_origin;
      }
      // Replay each event through the normal ingest path so handlers
      // registered before init still fire for historical events.
      const replay: SerializedEvent[] = (m.payload && m.payload.replay) || [];
      for (const ev of replay) ingest(ev);
      return;
    }
    if (m.kind === "event") {
      if (m.payload) ingest(m.payload);
      return;
    }
    if (m.kind === "ack") {
      const cid: string | undefined = m.correlation_id;
      if (cid && pendingEmits.has(cid)) {
        const p = pendingEmits.get(cid)!;
        pendingEmits.delete(cid);
        clearTimeout(p.timer);
        p.resolve({ id: m.event_id, deduped: !!m.deduped });
      }
      return;
    }
    if (m.kind === "error") {
      const ecid: string | undefined = m.correlation_id;
      if (ecid && pendingEmits.has(ecid)) {
        const pe = pendingEmits.get(ecid)!;
        pendingEmits.delete(ecid);
        clearTimeout(pe.timer);
        const err: PaneError = new Error(
          (m.error && m.error.message) || (m.error && m.error.code) || "emit failed",
        );
        if (m.error) {
          err.code = m.error.code;
          err.details = m.error.details;
        }
        pe.reject(err);
      }
      return;
    }
  });

  window.pane = Object.freeze({ emit, on, state });

  function announceReady(): void {
    parent.postMessage({ __pane: 1, v: 1, kind: "ready" }, "*");
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announceReady);
  } else {
    announceReady();
  }
})();
