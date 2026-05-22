// @vitest-environment jsdom
//
// Unit test for the shell-side `upload-blob-request` handler (follow-up C of
// #156). Runs the compiled shell bundle (dist/client/shell.client.js) inside
// a jsdom window, with a mocked `fetch` so we can assert exactly what the
// shell posts to /s/:token/blobs and how it forwards the relay's reply back
// to the iframe.
//
// The shell IIFE reads:
//   * `#pane-cfg` JSON script block — for the participant token + cfg.
//   * `#frame` iframe — the destination for postMessage replies. In jsdom
//     we render a stub iframe and dispatch frames as if they came from its
//     contentWindow.
//   * /v1/sessions/:id/ws-ticket — minted on the WebSocket-connect path; we
//     mock fetch so the connect never blocks the test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadClient } from "./routes.js";

const SHELL_JS = loadClient("shell.client.js");

const TOKEN = "tok_h_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SESSION_ID = "ses_test";

// Minimal cfg that satisfies the shell IIFE.
const CFG = {
  sessionId: SESSION_ID,
  schema: {},
  inputData: null,
  token: TOKEN,
  wsUrl: "ws://localhost/v1/sessions/ses_test/stream",
  isClosed: false,
  agentLive: false,
  agentLastEventAt: null,
  agentLastUsedAt: null,
};

function bootShell(): void {
  // Reset DOM.
  document.body.innerHTML = "";
  document.head.innerHTML = "";

  // Stub the cfg JSON block + the brand pill elements the shell reads.
  document.body.innerHTML = `
    <span id="dot"></span>
    <span id="status"></span>
    <span id="agent-dot"></span>
    <span id="agent-status"></span>
    <iframe id="frame"></iframe>
    <script type="application/json" id="pane-cfg">${JSON.stringify(CFG)}</script>
  `;

  // Mock WebSocket so the shell's connect() doesn't try a real network call.
  // We don't need to drive any WS messages for the uploadBlob test.
  class FakeWS {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeWS.CONNECTING;
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  (window as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;

  // Run the IIFE.
  new Function(SHELL_JS)();
}

describe("shell — upload-blob-request handler", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let iframePostSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bootShell();
    // Replace fetch with a fresh mock per test. The shell calls fetch for two
    // things: the WS ticket mint (we never await its result here because the
    // FakeWS short-circuits the connect) and the upload POST.
    fetchSpy = vi.fn();
    (window as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy;
    // Spy on the iframe's contentWindow.postMessage so we can assert the
    // shell's reply.
    const iframe = document.getElementById("frame") as HTMLIFrameElement;
    const cw = iframe.contentWindow!;
    iframePostSpy = vi.fn();
    (cw as unknown as { postMessage: typeof iframePostSpy }).postMessage =
      iframePostSpy;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  function dispatchFromIframe(data: unknown): void {
    const iframe = document.getElementById("frame") as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        source: iframe.contentWindow as Window,
      }),
    );
  }

  async function flushMicrotasks(): Promise<void> {
    // Give the void-async IIFE inside the shell time to settle. The shell
    // schedules the upload as a sibling task, so we wait a few ticks.
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  it("posts upload-blob-result ok:true with the relay's BlobRef on 2xx", async () => {
    const blobRef = {
      blob_id: "blob_abc",
      scope: "session",
      mime: "image/jpeg",
      size: 1234,
      sha256: "f".repeat(64),
      filename: "x.jpg",
      width: 64,
      height: 64,
      status: "ready",
      session_id: SESSION_ID,
      artifact_id: null,
      created_at: "2026-05-21T00:00:00.000Z",
      confirmed_at: "2026-05-21T00:00:00.000Z",
      deleted_at: null,
    };
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/blobs")) {
        return new Response(JSON.stringify(blobRef), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      // The WS-ticket fetch the shell mints during connect() — return a
      // ticket so connect() doesn't loop on errors.
      return new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 });
    });

    const file = new File([new Uint8Array([1, 2, 3])], "x.jpg", {
      type: "image/jpeg",
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "upload-blob-request",
      id: "u1",
      file,
    });

    await flushMicrotasks();

    // The shell must have fetched the /s/:token/blobs URL.
    const uploadCall = fetchSpy.mock.calls.find((c) =>
      (c[0] as string).includes("/blobs"),
    );
    expect(uploadCall).toBeTruthy();
    expect(uploadCall![0] as string).toContain("/s/");
    expect(uploadCall![0] as string).toContain("/blobs");
    expect((uploadCall![1] as RequestInit).method).toBe("POST");

    // It must have posted upload-blob-result back to the iframe with ok:true.
    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "upload-blob-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      __pane: 1,
      v: 1,
      kind: "upload-blob-result",
      id: "u1",
      ok: true,
      blob: { blob_id: "blob_abc", scope: "session" },
    });
  });

  it("posts ok:false with the relay's error code on a 4xx response", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/blobs")) {
        return new Response(
          JSON.stringify({
            error: {
              code: "mime_disallowed",
              message: "MIME 'text/html' is not in the allowlist",
            },
          }),
          {
            status: 415,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 });
    });

    const file = new File([new Uint8Array([1])], "x.jpg", {
      type: "image/jpeg",
    });
    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "upload-blob-request",
      id: "u2",
      file,
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "upload-blob-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "upload-blob-result",
      id: "u2",
      ok: false,
      error: { code: "mime_disallowed" },
    });
  });

  it("posts ok:false with code='network_error' when the fetch rejects", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/blobs")) {
        throw new TypeError("network failed");
      }
      return new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 });
    });

    const file = new File([new Uint8Array([1])], "x.jpg", {
      type: "image/jpeg",
    });
    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "upload-blob-request",
      id: "u3",
      file,
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "upload-blob-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "upload-blob-result",
      id: "u3",
      ok: false,
      error: { code: "network_error" },
    });
  });

  it("replies with invalid_request when the request lacks a File", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 }),
    );

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "upload-blob-request",
      id: "u4",
      // file is missing
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "upload-blob-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "upload-blob-result",
      id: "u4",
      ok: false,
      error: { code: "invalid_request" },
    });

    // The shell must NOT have called fetch for an upload — only the
    // ws-ticket mint is allowed.
    const uploadCalls = fetchSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("/blobs"),
    );
    expect(uploadCalls).toHaveLength(0);
  });
});

// ===========================================================================
// shell — download-blob-request handler (follow-up D of #156). Symmetric to
// the upload handler tests above; the shell brokers a GET to /s/:token/blobs/
// :blob_id and posts the resulting Blob back to the iframe via structured
// clone.
// ===========================================================================

describe("shell — download-blob-request handler", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let iframePostSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bootShell();
    fetchSpy = vi.fn();
    (window as unknown as { fetch: typeof fetchSpy }).fetch = fetchSpy;
    const iframe = document.getElementById("frame") as HTMLIFrameElement;
    const cw = iframe.contentWindow!;
    iframePostSpy = vi.fn();
    (cw as unknown as { postMessage: typeof iframePostSpy }).postMessage =
      iframePostSpy;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  function dispatchFromIframe(data: unknown): void {
    const iframe = document.getElementById("frame") as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        source: iframe.contentWindow as Window,
      }),
    );
  }

  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  it("posts download-blob-result ok:true with a Blob on 2xx", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/blobs/")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "download-blob-request",
      id: "d1",
      blob_id: "blob_abc",
    });

    await flushMicrotasks();

    const downloadCall = fetchSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/blobs/blob_abc"),
    );
    expect(downloadCall).toBeTruthy();
    expect(downloadCall![0] as string).toContain("/s/");
    // cache: 'no-store' is set on the fetch options.
    expect((downloadCall![1] as RequestInit).cache).toBe("no-store");

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "download-blob-result",
    );
    expect(reply).toBeTruthy();
    const payload = reply![0] as {
      kind: string;
      id: string;
      ok: boolean;
      blob: Blob;
      mime: string;
      size: number;
    };
    expect(payload).toMatchObject({
      __pane: 1,
      v: 1,
      kind: "download-blob-result",
      id: "d1",
      ok: true,
    });
    // The forwarded value is whatever `response.blob()` returned. Node 20
    // has two `Blob` constructors (`node:buffer`'s global vs undici's) and
    // happy-dom in tests returns yet another shape — `instanceof Blob` is
    // unreliable across CI vs local. Verify by the observable surface: the
    // type and size the iframe actually uses, which the shell pulled off
    // the Response and put into the result frame.
    expect(payload.blob).toBeTruthy();
    expect(payload.blob.constructor.name).toBe("Blob");
    expect(payload.blob.type).toBe("image/jpeg");
    expect(payload.mime).toBe("image/jpeg");
    expect(payload.size).toBe(4);
  });

  it("posts ok:false with the relay's error code on a 4xx response", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/blobs/")) {
        return new Response(
          JSON.stringify({
            error: {
              code: "blob_ref_not_accessible",
              message: "blob ref(s) not accessible: blob_abc",
            },
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "download-blob-request",
      id: "d2",
      blob_id: "blob_abc",
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "download-blob-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "download-blob-result",
      id: "d2",
      ok: false,
      error: { code: "blob_ref_not_accessible" },
    });
  });

  it("posts ok:false with code='fetch_error' when the fetch rejects", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/blobs/")) {
        throw new TypeError("network failed");
      }
      return new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "download-blob-request",
      id: "d3",
      blob_id: "blob_abc",
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "download-blob-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "download-blob-result",
      id: "d3",
      ok: false,
      error: { code: "fetch_error" },
    });
  });

  it("replies with invalid_request when the request lacks blob_id", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 }),
    );

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "download-blob-request",
      id: "d4",
      // blob_id is missing
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "download-blob-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "download-blob-result",
      id: "d4",
      ok: false,
      error: { code: "invalid_request" },
    });

    // No download fetch should have been made — only the ws-ticket mint.
    const downloadCalls = fetchSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/blobs/"),
    );
    expect(downloadCalls).toHaveLength(0);
  });
});
