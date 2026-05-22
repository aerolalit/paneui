// The `pane.*` shim. Compiled (with the client tsconfig) to
// `dist/client/shim.client.js` and inlined verbatim into the wrapped artifact
// page by `src/bridge/routes.ts`.
//
// Wire format mirrors docs/architecture/phase-3-human-side.md and is defined
// as shared types in ./protocol.ts:
//   iframe -> shell: { __pane:1, v:1, kind:"ready" | "emit", ... }
//   shell  -> iframe: { __pane:1, v:1, kind:"init" | "event" | "ack" | "error", ... }
//
// The whole body is wrapped in an IIFE so it's safe to inline into a
// <script> tag (no top-level scope leaks).
//
// `export {}` makes this a module (needed for the `declare global` below and
// TS file scoping). The relay's loadClient() strips it before inlining —
// `export` is a SyntaxError in the classic <script> the file is injected into.
export {};

// The shell <-> iframe frame envelope is defined ONCE in ./protocol.ts and
// shared (as a type) with the shell bundle, so the two sides cannot drift.
// `import type` is fully erased by the compiler — nothing reaches this IIFE.
import type {
  BlobRefLike,
  PaneFrameEnvelope,
  ShimToShellKind,
} from "./protocol.js";

interface SerializedEvent {
  id: string;
  type: string;
  data: unknown;
  [k: string]: unknown;
}

/** An outbound frame the shim posts to the shell. */
type OutboundFrame = PaneFrameEnvelope & {
  kind: ShimToShellKind;
  [k: string]: unknown;
};

interface EmitOpts {
  causationId?: string;
  idempotencyKey?: string;
}

interface UploadBlobOpts {
  filename?: string;
  mime?: string;
}

interface PaneApi {
  emit(
    type: string,
    data?: unknown,
    opts?: EmitOpts,
  ): Promise<{ id: string; deduped: boolean }>;
  on(type: string, handler: (ev: SerializedEvent) => void): () => void;
  state: {
    readonly events: SerializedEvent[];
    last(type?: string): SerializedEvent | undefined;
    subscribe(fn: () => void): () => void;
  };
  /**
   * Upload a browser `File` to the relay over the participant token bridge.
   * Returns a `BlobRef` the artifact can attach to a `pane.emit(...)` event
   * (e.g. `pane.emit('photo', { blob })`). Scope is forced to `session` on
   * the server — see `POST /s/:participantToken/blobs` in the relay.
   *
   * Resolves with the BlobRef on success. Rejects with an `Error` whose
   * `.code` carries the relay's error code (`mime_disallowed`,
   * `mime_mismatch`, `blob_size_exceeded`, `quota_exceeded`,
   * `participant_token_invalid`, `gone`, `invalid_request`, etc.) so the
   * artifact can branch on it.
   */
  uploadBlob(file: File, options?: UploadBlobOpts): Promise<BlobRefLike>;
  /**
   * Lazily fetch a blob's bytes by id. The blob must be referenced from
   * this session — either in the agent's initial `inputData` or in an
   * event the agent has emitted. The shell brokers the fetch with the
   * participant token; the iframe receives a live `Blob` it can render
   * via `URL.createObjectURL(blob)` (the iframe CSP allows `blob:` URLs
   * in `img-src`).
   *
   * Resolves with the `Blob` on success. Rejects with an `Error` whose
   * `.code` carries the relay's error code (`blob_ref_not_accessible`,
   * `participant_token_invalid`, `gone`, etc.) so the artifact can branch
   * on it.
   *
   * Prefer this over embedding the bytes in the event data: a 1 MB image
   * won't fit under `MAX_EVENT_DATA_BYTES`, and replayed inline bytes are
   * sent over WS on every reconnect.
   */
  downloadBlob(blobId: string): Promise<Blob>;
  /**
   * Trigger a browser save (download to disk / Files / Photos) of a blob
   * the session references. Unlike `downloadBlob` which hands the iframe
   * the bytes, `saveBlob` only kicks off the OS save flow — the iframe
   * doesn't receive the bytes. Use this for non-image files (PDFs, CSVs,
   * archives) the human is meant to save rather than view inline.
   *
   * The shell runs the actual `<a download>` click from the OUTER, non-
   * sandboxed document, which is the only way iOS Safari / iOS Chrome
   * (both WebKit) reliably save files — downloads from inside a sandboxed
   * iframe are silently dropped on those browsers.
   *
   * Resolves when the shell has kicked off the download; rejects with
   * an `Error` whose `.code` carries the relay's error code on failure.
   */
  saveBlob(blobId: string, filename?: string): Promise<void>;
  /**
   * The session's per-instance seed data — the `input_data` the agent passed
   * to `POST /v1/sessions`, validated by the relay against the artifact
   * version's `input_schema`. `null` when the session was created without
   * `input_data`. Read it to render this instance, e.g. a PR-review artifact
   * does `window.pane.inputData.prTitle`.
   *
   * Not populated until the shell delivers the `init` frame — read it AFTER
   * `await pane.ready` to avoid a `null` race on first render.
   */
  readonly inputData: unknown;
  /**
   * Resolves exactly once, when the shell's `init` frame has been processed
   * and `inputData` + the historical event replay are available. Pages that
   * read `inputData` or react to past events on first paint should `await`
   * it before reading — `window.pane` is published synchronously, but
   * `inputData` is unknown until init lands.
   *
   * ```js
   * await window.pane.ready;
   * const id = window.pane.inputData?.imageBlobId;
   * ```
   *
   * The Promise stays pending if the page never receives an `init` frame
   * (e.g. it was loaded outside a Pane shell). Resolves with `void`;
   * sessions with no `input_data` still resolve (the resolution signals
   * "init received," not "input_data is non-null").
   */
  readonly ready: Promise<void>;
}

interface PendingEmit {
  resolve: (v: { id: string; deduped: boolean }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingUpload {
  resolve: (blob: BlobRefLike) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingDownload {
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingSave {
  resolve: () => void;
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
  const pendingUploads = new Map<string, PendingUpload>();
  const pendingDownloads = new Map<string, PendingDownload>();
  const pendingSaves = new Map<string, PendingSave>();
  const stateEvents: SerializedEvent[] = [];
  const stateSubscribers = new Set<() => void>();
  const lastByType = new Map<string, SerializedEvent>();
  let nextCorr = 1;
  let nextUploadId = 1;
  let nextDownloadId = 1;
  let nextSaveId = 1;
  // The session's per-instance input_data. Unknown until the 'init' frame
  // arrives (the relay validated it against the artifact version's
  // input_schema at session-create time). Exposed on the frozen `window.pane`
  // via a getter (see below) so the value can be filled in after `window.pane`
  // is already published — the getter reads this mutable backing variable.
  let inputData: unknown = null;
  // `window.pane.ready` — resolves on the first 'init' frame. Created
  // eagerly so callers can `await pane.ready` without racing the message
  // listener. The resolver is captured in the executor and called from the
  // init branch below; subsequent inits are ignored (init is one-shot).
  let resolveReady: () => void = () => {};
  let readyResolved = false;
  const ready: Promise<void> = new Promise((resolve) => {
    resolveReady = resolve;
  });
  // Shell origin is unknown until 'init' arrives — the very first 'ready'
  // post is sent with target "*" (no secrets) and outbound posts after init
  // are pinned to the shell origin learnt from the handshake.
  let shellOrigin: string = "*";

  function notifyState(): void {
    stateSubscribers.forEach((fn) => {
      try {
        fn();
      } catch {
        /* swallow */
      }
    });
  }

  function ingest(ev: SerializedEvent): void {
    stateEvents.push(ev);
    lastByType.set(ev.type, ev);
    notifyState();
    const hs = handlers.get(ev.type);
    if (hs) {
      hs.forEach((h) => {
        try {
          h(ev);
        } catch {
          /* swallow */
        }
      });
    }
  }

  const state = Object.freeze({
    get events(): SerializedEvent[] {
      return stateEvents.slice();
    },
    last(type?: string): SerializedEvent | undefined {
      if (type === undefined) {
        return stateEvents.length
          ? stateEvents[stateEvents.length - 1]
          : undefined;
      }
      return lastByType.get(type);
    },
    subscribe(fn: () => void): () => void {
      stateSubscribers.add(fn);
      return () => {
        stateSubscribers.delete(fn);
      };
    },
  });

  function on(
    type: string,
    handler: (ev: SerializedEvent) => void,
  ): () => void {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  function emit(
    type: string,
    data?: unknown,
    opts?: EmitOpts,
  ): Promise<{ id: string; deduped: boolean }> {
    const corr = "c" + nextCorr++;
    const frame: OutboundFrame = {
      __pane: 1,
      v: 1,
      kind: "emit",
      correlation_id: corr,
      type: String(type),
      data: data == null ? {} : data,
    };
    if (opts && typeof opts === "object") {
      if (typeof opts.causationId === "string")
        frame["causation_id"] = opts.causationId;
      if (typeof opts.idempotencyKey === "string")
        frame["idempotency_key"] = opts.idempotencyKey;
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

  // window.pane.uploadBlob(file, options?) — thin postMessage RPC to the
  // shell, which holds the participant token and brokers the
  // POST /s/:token/blobs request. The browser's structured-clone of `File`
  // means the shell receives a live File handle it can hand to FormData
  // without any base64/ArrayBuffer round trip.
  //
  // Uploads can be slow (a multi-megabyte image over a flaky mobile link),
  // so the timeout here is much wider than emit()'s — but still bounded so
  // a wedged shell can't leak the Promise forever.
  function uploadBlob(
    file: File,
    options?: UploadBlobOpts,
  ): Promise<BlobRefLike> {
    if (!(file instanceof File)) {
      return Promise.reject(new Error("uploadBlob: argument must be a File"));
    }
    const id = "u" + nextUploadId++;
    const frame: OutboundFrame = {
      __pane: 1,
      v: 1,
      kind: "upload-blob-request",
      id,
      file,
    };
    if (options && typeof options === "object") {
      const opts: Record<string, string> = {};
      if (typeof options.filename === "string")
        opts["filename"] = options.filename;
      if (typeof options.mime === "string") opts["mime"] = options.mime;
      if (Object.keys(opts).length) frame["options"] = opts;
    }
    // shellOrigin defaults to "*" until init lands; mirroring how emit()
    // posts to shellOrigin keeps the cross-origin posture consistent.
    parent.postMessage(frame, shellOrigin);
    return new Promise<BlobRefLike>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (pendingUploads.has(id)) {
            pendingUploads.delete(id);
            reject(new Error("upload timeout"));
          }
        },
        // 2 minutes — covers a 5 MB upload on a slow mobile link plus the
        // server-side sharp normalisation pass.
        2 * 60 * 1000,
      );
      pendingUploads.set(id, { resolve, reject, timer });
    });
  }

  // window.pane.downloadBlob(blob_id) — thin postMessage RPC to the shell,
  // which holds the participant token and brokers a GET to
  // /s/:token/blobs/:blob_id on the iframe's behalf. The browser's
  // structured-clone of `Blob` means the shell can hand the iframe a live
  // Blob reference (no base64 round trip). The iframe's CSP allows `blob:`
  // URLs in `img-src`, so `URL.createObjectURL(blob)` renders cleanly.
  //
  // Follow-up D of #156. Symmetric to uploadBlob.
  function downloadBlob(blobId: string): Promise<Blob> {
    if (typeof blobId !== "string" || blobId.length === 0) {
      // Local rejection — never post a malformed frame. Mirrors the
      // non-File guard in uploadBlob and the relay's invalid_args surface.
      const err: PaneError = new Error(
        "downloadBlob: blob_id must be a non-empty string",
      );
      err.code = "invalid_args";
      return Promise.reject(err);
    }
    const id = "d" + nextDownloadId++;
    const frame: OutboundFrame = {
      __pane: 1,
      v: 1,
      kind: "download-blob-request",
      id,
      blob_id: blobId,
    };
    parent.postMessage(frame, shellOrigin);
    return new Promise<Blob>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (pendingDownloads.has(id)) {
            pendingDownloads.delete(id);
            reject(new Error("download timeout"));
          }
        },
        // 2 minutes — matches uploadBlob. A multi-MB image over a flaky
        // mobile link plus the decrypt pass should comfortably fit.
        2 * 60 * 1000,
      );
      pendingDownloads.set(id, { resolve, reject, timer });
    });
  }

  // window.pane.saveBlob(blob_id, filename?) — asks the shell to trigger a
  // browser save (download) for a blob referenced by this session. The shell
  // does the `<a download>` click from its own (non-sandboxed) document; the
  // sandbox `allow-downloads` flag is NOT sufficient on iOS WebKit, which
  // silently drops sandboxed-iframe downloads even with it. Returning from
  // the OUTER document is the only reliable cross-browser path.
  //
  // No bytes flow back to the iframe — the iframe only learns whether the
  // download started (ok) or which error fired.
  function saveBlob(blobId: string, filename?: string): Promise<void> {
    if (typeof blobId !== "string" || blobId.length === 0) {
      const err: PaneError = new Error(
        "saveBlob: blob_id must be a non-empty string",
      );
      err.code = "invalid_args";
      return Promise.reject(err);
    }
    const id = "s" + nextSaveId++;
    const frame: OutboundFrame = {
      __pane: 1,
      v: 1,
      kind: "save-blob-request",
      id,
      blob_id: blobId,
    };
    if (typeof filename === "string" && filename.length > 0) {
      // Trim oversized / weird filenames defensively — the shell sanitises
      // again but a short cap here avoids a malformed-frame round trip.
      frame.filename = filename.slice(0, 255);
    }
    parent.postMessage(frame, shellOrigin);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (pendingSaves.has(id)) {
            pendingSaves.delete(id);
            reject(new Error("save timeout"));
          }
        },
        // 2 minutes — matches download/upload, accommodates a slow fetch
        // through the shell on a poor mobile link.
        2 * 60 * 1000,
      );
      pendingSaves.set(id, { resolve, reject, timer });
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
      // The init frame carries this session's `input_data` — the per-instance
      // seed data the agent passed at session-create, already validated by the
      // relay against the artifact version's `input_schema`. Store it so the
      // `window.pane.inputData` getter can surface it to the artifact.
      if (m.payload && "input_data" in m.payload) {
        inputData = m.payload.input_data;
      }
      // Replay each event through the normal ingest path so handlers
      // registered before init still fire for historical events.
      const replay: SerializedEvent[] = (m.payload && m.payload.replay) || [];
      for (const ev of replay) ingest(ev);
      // Resolve `pane.ready` exactly once, AFTER input_data and the replay
      // are visible — that's the contract callers depend on
      // (`await pane.ready; pane.inputData.x`). Re-entrant init frames
      // (shouldn't happen, but defend) are no-ops on the Promise.
      if (!readyResolved) {
        readyResolved = true;
        resolveReady();
      }
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
          (m.error && m.error.message) ||
            (m.error && m.error.code) ||
            "emit failed",
        );
        if (m.error) {
          err.code = m.error.code;
          err.details = m.error.details;
        }
        pe.reject(err);
      }
      return;
    }
    if (m.kind === "upload-blob-result") {
      const uid: string | undefined = m.id;
      if (!uid || !pendingUploads.has(uid)) return;
      const pu = pendingUploads.get(uid)!;
      pendingUploads.delete(uid);
      clearTimeout(pu.timer);
      if (m.ok === true && m.blob) {
        pu.resolve(m.blob as BlobRefLike);
      } else {
        const errInfo = (m.error || {}) as { code?: string; message?: string };
        const err: PaneError = new Error(
          errInfo.message || errInfo.code || "upload failed",
        );
        if (errInfo.code) err.code = errInfo.code;
        pu.reject(err);
      }
      return;
    }
    if (m.kind === "download-blob-result") {
      const did: string | undefined = m.id;
      if (!did || !pendingDownloads.has(did)) return;
      const pd = pendingDownloads.get(did)!;
      pendingDownloads.delete(did);
      clearTimeout(pd.timer);
      if (m.ok === true && m.blob instanceof Blob) {
        pd.resolve(m.blob as Blob);
      } else {
        const errInfo = (m.error || {}) as { code?: string; message?: string };
        const err: PaneError = new Error(
          errInfo.message || errInfo.code || "download failed",
        );
        if (errInfo.code) err.code = errInfo.code;
        pd.reject(err);
      }
      return;
    }
    if (m.kind === "save-blob-result") {
      const sid: string | undefined = m.id;
      if (!sid || !pendingSaves.has(sid)) return;
      const ps = pendingSaves.get(sid)!;
      pendingSaves.delete(sid);
      clearTimeout(ps.timer);
      if (m.ok === true) {
        ps.resolve();
      } else {
        const errInfo = (m.error || {}) as { code?: string; message?: string };
        const err: PaneError = new Error(
          errInfo.message || errInfo.code || "save failed",
        );
        if (errInfo.code) err.code = errInfo.code;
        ps.reject(err);
      }
      return;
    }
  });

  // `window.pane` is frozen so the artifact can't tamper with the bridge. But
  // `inputData` only becomes known when the `init` frame arrives — after this
  // object is published. So `inputData` is exposed as a GETTER over the
  // mutable `inputData` backing variable: the property descriptor is frozen
  // (the artifact can't replace the getter), yet the value it returns reflects
  // whatever `init` delivered. An artifact reads its per-instance seed data as
  // `window.pane.inputData` — e.g. a PR-review page does
  // `window.pane.inputData.prTitle`.
  window.pane = Object.freeze({
    emit,
    on,
    state,
    uploadBlob,
    downloadBlob,
    saveBlob,
    ready,
    get inputData(): unknown {
      return inputData;
    },
  });

  function announceReady(): void {
    const frame: OutboundFrame = { __pane: 1, v: 1, kind: "ready" };
    parent.postMessage(frame, "*");
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announceReady);
  } else {
    announceReady();
  }
})();
