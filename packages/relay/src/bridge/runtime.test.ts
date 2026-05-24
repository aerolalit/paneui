// @vitest-environment jsdom
//
// Unit test for the page-side `pane.*` runtime. Executes the COMPILED bundle
// (dist/client/runtime.client.js — produced by the pretest:unit `build:client`
// hook) inside a jsdom window. The runtime is authored as a TS module;
// loadClient strips the `export {}` marker so the result runs as a classic
// script.
//
// In jsdom `window.parent === window`, so the runtime's `parent.postMessage`
// and the `e.source !== parent` guard both resolve against this same window —
// we dispatch MessageEvents with `source: window` and spy on `postMessage`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadClient } from "./routes.js";

const RUNTIME_JS = loadClient("runtime.client.js");

// The runtime installs `window.pane` and a `message` listener. Each test needs
// a pristine instance, so we tear those down and re-run the bundle per test.
function freshRuntime(): void {
  // Remove a prior install's global so the new IIFE assigns cleanly
  // (window.pane is frozen, so delete rather than overwrite).
  delete (window as unknown as { pane?: unknown }).pane;
  new Function(RUNTIME_JS)();
}

describe("pane runtime", () => {
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy BEFORE running the runtime so the startup `ready` post is captured too.
    postSpy = vi.spyOn(window.parent, "postMessage");
    freshRuntime();
  });

  afterEach(() => {
    postSpy.mockRestore();
  });

  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data, source: window }));
  }

  it("fires on() handlers for replay events delivered with init", () => {
    const spy = vi.fn();
    window.pane.on("some.type", spy);

    dispatch({
      __pane: 1,
      v: 1,
      kind: "init",
      payload: {
        shell_origin: "http://shell",
        replay: [{ id: "e1", type: "some.type", data: { x: 1 } }],
      },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1", type: "some.type" }),
    );
    expect(window.pane.state.events).toHaveLength(1);
  });

  it("rejects a pending emit with .code on a shell error frame", async () => {
    const p = window.pane.emit("some.type", { x: 1 });

    // The most recent post is the emit frame — pull its correlation_id.
    const emitFrame = postSpy.mock.calls.at(-1)?.[0] as {
      kind: string;
      correlation_id: string;
    };
    expect(emitFrame.kind).toBe("emit");

    dispatch({
      __pane: 1,
      v: 1,
      kind: "error",
      correlation_id: emitFrame.correlation_id,
      error: { code: "invalid_request", message: "bad" },
    });

    await expect(p).rejects.toThrowError("bad");
    await p.catch((err: { code?: string }) => {
      expect(err.code).toBe("invalid_request");
    });
  });

  it("exposes input_data from the init frame as window.pane.inputData", () => {
    // Before init, inputData is null (the value is unknown until the handshake).
    expect(window.pane.inputData).toBeNull();

    dispatch({
      __pane: 1,
      v: 1,
      kind: "init",
      payload: {
        shell_origin: "http://shell",
        replay: [],
        input_data: { prTitle: "Fix the bug", files: ["a.ts"] },
      },
    });

    expect(window.pane.inputData).toEqual({
      prTitle: "Fix the bug",
      files: ["a.ts"],
    });
  });

  it("leaves window.pane.inputData null when init carries none", () => {
    dispatch({
      __pane: 1,
      v: 1,
      kind: "init",
      payload: { shell_origin: "http://shell", replay: [] },
    });
    expect(window.pane.inputData).toBeNull();
  });

  it("exposes window.pane.ready as a Promise that resolves on the first init frame", async () => {
    // Eagerly published before init; awaiting it before init lands must not
    // throw and must not resolve.
    expect(window.pane.ready).toBeInstanceOf(Promise);

    let resolved = false;
    void window.pane.ready.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    dispatch({
      __pane: 1,
      v: 1,
      kind: "init",
      payload: {
        shell_origin: "http://shell",
        replay: [],
        input_data: { x: 1 },
      },
    });

    // Awaiting the same Promise instance now resolves.
    await window.pane.ready;
    expect(resolved).toBe(true);
    // inputData is visible by the time ready resolves — that's the contract.
    expect(window.pane.inputData).toEqual({ x: 1 });
  });

  it("resolves window.pane.ready even when the init frame carries no input_data", async () => {
    dispatch({
      __pane: 1,
      v: 1,
      kind: "init",
      payload: { shell_origin: "http://shell", replay: [] },
    });
    await window.pane.ready;
    expect(window.pane.inputData).toBeNull();
  });

  it("window.pane.ready is the same Promise across reads (single instance)", () => {
    const a = window.pane.ready;
    const b = window.pane.ready;
    expect(a).toBe(b);
  });

  it("subsequent init frames do not re-resolve ready (idempotent)", async () => {
    let resolveCount = 0;
    void window.pane.ready.then(() => {
      resolveCount++;
    });

    dispatch({
      __pane: 1,
      v: 1,
      kind: "init",
      payload: { shell_origin: "http://shell", replay: [] },
    });
    dispatch({
      __pane: 1,
      v: 1,
      kind: "init",
      payload: { shell_origin: "http://shell", replay: [] },
    });
    await window.pane.ready;
    // One microtask + a couple of frame turns to flush any extra .then().
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveCount).toBe(1);
  });

  it("posts outbound emits to the shell origin learnt from init", () => {
    dispatch({
      __pane: 1,
      v: 1,
      kind: "init",
      payload: { shell_origin: "http://shell.example", replay: [] },
    });

    window.pane.emit("some.type", { x: 1 });

    const lastCall = postSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ kind: "emit" });
    expect(lastCall?.[1]).toBe("http://shell.example");
  });
});

// ===========================================================================
// window.pane.uploadBlob — postMessage RPC to the shell. Tests the iframe
// side in isolation: a real File goes out as an `upload-blob-request` frame,
// a synthetic `upload-blob-result` frame resolves or rejects the promise.
// Follow-up C of #156.
// ===========================================================================

describe("pane.uploadBlob", () => {
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    postSpy = vi.spyOn(window.parent, "postMessage");
    freshRuntime();
  });

  afterEach(() => {
    postSpy.mockRestore();
  });

  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data, source: window }));
  }

  const fakeBlobRef = {
    blob_id: "blob_abc",
    scope: "session" as const,
    mime: "image/jpeg",
    size: 1234,
    sha256: "f".repeat(64),
    filename: "selfie.jpg",
    width: 64,
    height: 64,
    status: "ready",
    session_id: "ses_x",
    artifact_id: null,
    created_at: "2026-05-21T00:00:00.000Z",
    confirmed_at: "2026-05-21T00:00:00.000Z",
    deleted_at: null,
  };

  it("posts an upload-blob-request frame carrying the File and an id", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "selfie.jpg", {
      type: "image/jpeg",
    });
    const p = window.pane.uploadBlob(file);
    void p;
    // Most recent post is the upload-blob-request.
    const last = postSpy.mock.calls.at(-1)?.[0] as {
      kind: string;
      id: string;
      file: File;
    };
    expect(last.kind).toBe("upload-blob-request");
    expect(typeof last.id).toBe("string");
    expect(last.id.length).toBeGreaterThan(0);
    expect(last.file).toBe(file);
  });

  it("resolves with the blob on an ok:true result", async () => {
    const file = new File([new Uint8Array([1])], "x.jpg", {
      type: "image/jpeg",
    });
    const p = window.pane.uploadBlob(file);

    const req = postSpy.mock.calls.at(-1)?.[0] as { id: string };
    dispatch({
      __pane: 1,
      v: 1,
      kind: "upload-blob-result",
      id: req.id,
      ok: true,
      blob: fakeBlobRef,
    });

    await expect(p).resolves.toMatchObject({
      blob_id: "blob_abc",
      scope: "session",
    });
  });

  it("rejects with an Error carrying .code on an ok:false result", async () => {
    const file = new File([new Uint8Array([1])], "x.jpg", {
      type: "image/jpeg",
    });
    const p = window.pane.uploadBlob(file);

    const req = postSpy.mock.calls.at(-1)?.[0] as { id: string };
    dispatch({
      __pane: 1,
      v: 1,
      kind: "upload-blob-result",
      id: req.id,
      ok: false,
      error: { code: "blob_size_exceeded", message: "too big" },
    });

    await expect(p).rejects.toThrowError("too big");
    await p.catch((err: { code?: string }) => {
      expect(err.code).toBe("blob_size_exceeded");
    });
  });

  it("does not resolve request 1 when request 2's result arrives", async () => {
    const f1 = new File([new Uint8Array([1])], "a", { type: "image/jpeg" });
    const f2 = new File([new Uint8Array([2])], "b", { type: "image/jpeg" });
    const p1 = window.pane.uploadBlob(f1);
    const p2 = window.pane.uploadBlob(f2);

    // The most recent two posts are the two requests, in order.
    const calls = postSpy.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === "upload-blob-request",
    );
    const req1 = calls.at(-2)?.[0] as { id: string };
    const req2 = calls.at(-1)?.[0] as { id: string };
    expect(req1.id).not.toBe(req2.id);

    // Reply to request 2 only.
    dispatch({
      __pane: 1,
      v: 1,
      kind: "upload-blob-result",
      id: req2.id,
      ok: true,
      blob: fakeBlobRef,
    });

    // p2 resolves; p1 still pending (proxied through a Promise.race-with-
    // timeout to assert that without waiting the full 2-minute timeout).
    const sentinel = Symbol("pending");
    const result = await Promise.race([
      p1.then((v) => v as unknown),
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 0)),
    ]);
    expect(result).toBe(sentinel);
    await expect(p2).resolves.toMatchObject({ blob_id: "blob_abc" });

    // Now reply to request 1 with a different blob_id — must resolve p1
    // distinctly (no cross-correlation).
    dispatch({
      __pane: 1,
      v: 1,
      kind: "upload-blob-result",
      id: req1.id,
      ok: true,
      blob: { ...fakeBlobRef, blob_id: "blob_other" },
    });
    await expect(p1).resolves.toMatchObject({ blob_id: "blob_other" });
  });

  it("rejects synchronously when given a non-File argument", async () => {
    // The function returns Promise.reject(...) — the iframe shouldn't post
    // a malformed frame.
    const callsBefore = postSpy.mock.calls.length;
    const p = window.pane.uploadBlob("not-a-file" as unknown as File);
    await expect(p).rejects.toThrowError(/must be a File/);
    // No new frame should have been posted.
    expect(postSpy.mock.calls.length).toBe(callsBefore);
  });

  it("forwards filename + mime options on the request frame", () => {
    const file = new File([new Uint8Array([1])], "orig.jpg", {
      type: "image/jpeg",
    });
    window.pane.uploadBlob(file, {
      filename: "override.jpg",
      mime: "image/png",
    });
    const last = postSpy.mock.calls.at(-1)?.[0] as {
      kind: string;
      options: { filename?: string; mime?: string };
    };
    expect(last.kind).toBe("upload-blob-request");
    expect(last.options).toEqual({
      filename: "override.jpg",
      mime: "image/png",
    });
  });
});

// ===========================================================================
// window.pane.downloadBlob — postMessage RPC to the shell. Tests the iframe
// side in isolation: a blob_id goes out as a `download-blob-request` frame,
// a synthetic `download-blob-result` carrying a real Blob resolves or
// rejects the promise. Follow-up D of #156 (symmetric to uploadBlob).
// ===========================================================================

describe("pane.downloadBlob", () => {
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    postSpy = vi.spyOn(window.parent, "postMessage");
    freshRuntime();
  });

  afterEach(() => {
    postSpy.mockRestore();
  });

  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data, source: window }));
  }

  it("posts a download-blob-request frame carrying the blob_id and a correlation id", () => {
    const p = window.pane.downloadBlob("blob_abc");
    void p;
    const last = postSpy.mock.calls.at(-1)?.[0] as {
      kind: string;
      id: string;
      blob_id: string;
    };
    expect(last.kind).toBe("download-blob-request");
    expect(typeof last.id).toBe("string");
    expect(last.id.length).toBeGreaterThan(0);
    expect(last.blob_id).toBe("blob_abc");
  });

  it("resolves with the Blob on an ok:true result", async () => {
    const p = window.pane.downloadBlob("blob_abc");

    const req = postSpy.mock.calls.at(-1)?.[0] as { id: string };
    const fakeBlob = new Blob([new Uint8Array([1, 2, 3])], {
      type: "image/jpeg",
    });
    dispatch({
      __pane: 1,
      v: 1,
      kind: "download-blob-result",
      id: req.id,
      ok: true,
      blob: fakeBlob,
      mime: "image/jpeg",
      size: 3,
    });

    const got = await p;
    expect(got).toBeInstanceOf(Blob);
    expect(got.type).toBe("image/jpeg");
    expect(got.size).toBe(3);
  });

  it("rejects with an Error carrying .code on an ok:false result", async () => {
    const p = window.pane.downloadBlob("blob_abc");

    const req = postSpy.mock.calls.at(-1)?.[0] as { id: string };
    dispatch({
      __pane: 1,
      v: 1,
      kind: "download-blob-result",
      id: req.id,
      ok: false,
      error: { code: "blob_ref_not_accessible", message: "not yours" },
    });

    await expect(p).rejects.toThrowError("not yours");
    await p.catch((err: { code?: string }) => {
      expect(err.code).toBe("blob_ref_not_accessible");
    });
  });

  it("does not resolve request 1 when request 2's result arrives", async () => {
    const p1 = window.pane.downloadBlob("blob_one");
    const p2 = window.pane.downloadBlob("blob_two");

    const calls = postSpy.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === "download-blob-request",
    );
    const req1 = calls.at(-2)?.[0] as { id: string };
    const req2 = calls.at(-1)?.[0] as { id: string };
    expect(req1.id).not.toBe(req2.id);

    // Reply to request 2 only.
    const blob2 = new Blob([new Uint8Array([2])], { type: "image/jpeg" });
    dispatch({
      __pane: 1,
      v: 1,
      kind: "download-blob-result",
      id: req2.id,
      ok: true,
      blob: blob2,
      mime: "image/jpeg",
      size: 1,
    });

    const sentinel = Symbol("pending");
    const result = await Promise.race([
      p1.then((v) => v as unknown),
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 0)),
    ]);
    expect(result).toBe(sentinel);
    await expect(p2).resolves.toBeInstanceOf(Blob);

    const blob1 = new Blob([new Uint8Array([1])], { type: "image/png" });
    dispatch({
      __pane: 1,
      v: 1,
      kind: "download-blob-result",
      id: req1.id,
      ok: true,
      blob: blob1,
      mime: "image/png",
      size: 1,
    });
    const got1 = await p1;
    expect(got1.type).toBe("image/png");
  });

  it("rejects synchronously without posting on a non-string blob_id", async () => {
    const callsBefore = postSpy.mock.calls.length;
    const p = window.pane.downloadBlob(123 as unknown as string);
    await expect(p).rejects.toThrowError(/non-empty string/);
    await p.catch((err: { code?: string }) => {
      expect(err.code).toBe("invalid_args");
    });
    expect(postSpy.mock.calls.length).toBe(callsBefore);
  });

  it("rejects synchronously without posting on an empty blob_id", async () => {
    const callsBefore = postSpy.mock.calls.length;
    const p = window.pane.downloadBlob("");
    await expect(p).rejects.toThrowError(/non-empty string/);
    expect(postSpy.mock.calls.length).toBe(callsBefore);
  });
});
