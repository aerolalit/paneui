// @vitest-environment jsdom
//
// Unit test for the shell-side `upload-attachment-request` handler (follow-up C of
// #156). Runs the compiled shell bundle (dist/client/shell.client.js) inside
// a jsdom window, with a mocked `fetch` so we can assert exactly what the
// shell posts to /s/:token/attachments and how it forwards the relay's reply back
// to the iframe.
//
// The shell IIFE reads:
//   * `#pane-cfg` JSON script block — for the participant token + cfg.
//   * `#frame` iframe — the destination for postMessage replies. In jsdom
//     we render a stub iframe and dispatch frames as if they came from its
//     contentWindow.
//   * /v1/panes/:id/ws-ticket — minted on the WebSocket-connect path; we
//     mock fetch so the connect never blocks the test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadClient } from "./routes.js";

const SHELL_JS = loadClient("shell.client.js");

const TOKEN = "tok_h_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PANE_ID = "pan_test";

// Minimal cfg that satisfies the shell IIFE. The shell takes its callback URLs
// from the cfg block rather than constructing them from a token (the same
// bundle now drives the capability-token mount AND the cookie-authed
// /panes/:id mount), so we mirror the same /s/:token paths the bridge
// route emits — the existing assertions still check the same URLs.
const CFG = {
  paneId: PANE_ID,
  schema: {},
  inputData: null,
  presenceUrl: `/s/${TOKEN}/presence`,
  wsTicketUrl: `/v1/panes/${PANE_ID}/ws-ticket`,
  wsTicketAuthorization: `Bearer ${TOKEN}`,
  attachmentsUploadUrl: `/s/${TOKEN}/attachments`,
  attachmentsDownloadUrlBase: `/s/${TOKEN}/attachments`,
  wsUrl: "ws://localhost/v1/panes/pan_test/stream",
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

describe("shell — upload-attachment-request handler", () => {
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

  it("posts upload-attachment-result ok:true with the relay's AttachmentRef on 2xx", async () => {
    const blobRef = {
      attachment_id: "attachment_abc",
      scope: "pane",
      mime: "image/jpeg",
      size: 1234,
      sha256: "f".repeat(64),
      filename: "x.jpg",
      width: 64,
      height: 64,
      status: "ready",
      pane_id: PANE_ID,
      template_id: null,
      created_at: "2026-05-21T00:00:00.000Z",
      confirmed_at: "2026-05-21T00:00:00.000Z",
      deleted_at: null,
    };
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/attachments")) {
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
      kind: "upload-attachment-request",
      id: "u1",
      file,
    });

    await flushMicrotasks();

    // The shell must have fetched the /s/:token/attachments URL.
    const uploadCall = fetchSpy.mock.calls.find((c) =>
      (c[0] as string).includes("/attachments"),
    );
    expect(uploadCall).toBeTruthy();
    expect(uploadCall![0] as string).toContain("/s/");
    expect(uploadCall![0] as string).toContain("/attachments");
    expect((uploadCall![1] as RequestInit).method).toBe("POST");

    // It must have posted upload-attachment-result back to the iframe with ok:true.
    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "upload-attachment-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      __pane: 1,
      v: 1,
      kind: "upload-attachment-result",
      id: "u1",
      ok: true,
      attachment: { attachment_id: "attachment_abc", scope: "pane" },
    });
  });

  it("posts ok:false with the relay's error code on a 4xx response", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/attachments")) {
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
      kind: "upload-attachment-request",
      id: "u2",
      file,
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "upload-attachment-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "upload-attachment-result",
      id: "u2",
      ok: false,
      error: { code: "mime_disallowed" },
    });
  });

  it("posts ok:false with code='network_error' when the fetch rejects", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/attachments")) {
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
      kind: "upload-attachment-request",
      id: "u3",
      file,
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "upload-attachment-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "upload-attachment-result",
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
      kind: "upload-attachment-request",
      id: "u4",
      // file is missing
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "upload-attachment-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "upload-attachment-result",
      id: "u4",
      ok: false,
      error: { code: "invalid_request" },
    });

    // The shell must NOT have called fetch for an upload — only the
    // ws-ticket mint is allowed.
    const uploadCalls = fetchSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("/attachments"),
    );
    expect(uploadCalls).toHaveLength(0);
  });
});

// ===========================================================================
// shell — download-attachment-request handler (follow-up D of #156). Symmetric to
// the upload handler tests above; the shell brokers a GET to /s/:token/attachments/
// :attachment_id and posts the resulting Blob back to the iframe via structured
// clone.
// ===========================================================================

describe("shell — download-attachment-request handler", () => {
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

  it("posts download-attachment-result ok:true with a Blob on 2xx", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/attachments/")) {
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
      kind: "download-attachment-request",
      id: "d1",
      attachment_id: "attachment_abc",
    });

    await flushMicrotasks();

    const downloadCall = fetchSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/attachments/attachment_abc"),
    );
    expect(downloadCall).toBeTruthy();
    expect(downloadCall![0] as string).toContain("/s/");
    // cache: 'no-store' is set on the fetch options.
    expect((downloadCall![1] as RequestInit).cache).toBe("no-store");

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "download-attachment-result",
    );
    expect(reply).toBeTruthy();
    const payload = reply![0] as {
      kind: string;
      id: string;
      ok: boolean;
      attachment: Blob;
      mime: string;
      size: number;
    };
    expect(payload).toMatchObject({
      __pane: 1,
      v: 1,
      kind: "download-attachment-result",
      id: "d1",
      ok: true,
    });
    // The forwarded value is whatever `response.attachment()` returned. Node 20
    // has two `Blob` constructors (`node:buffer`'s global vs undici's) and
    // happy-dom in tests returns yet another shape — `instanceof Blob` is
    // unreliable across CI vs local. Verify by the observable pane: the
    // type and size the iframe actually uses, which the shell pulled off
    // the Response and put into the result frame.
    expect(payload.attachment).toBeTruthy();
    expect(payload.attachment.constructor.name).toBe("Blob");
    expect(payload.attachment.type).toBe("image/jpeg");
    expect(payload.mime).toBe("image/jpeg");
    expect(payload.size).toBe(4);
  });

  it("posts ok:false with the relay's error code on a 4xx response", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/attachments/")) {
        return new Response(
          JSON.stringify({
            error: {
              code: "attachment_ref_not_accessible",
              message: "attachment ref(s) not accessible: attachment_abc",
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
      kind: "download-attachment-request",
      id: "d2",
      attachment_id: "attachment_abc",
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "download-attachment-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "download-attachment-result",
      id: "d2",
      ok: false,
      error: { code: "attachment_ref_not_accessible" },
    });
  });

  it("posts ok:false with code='fetch_error' when the fetch rejects", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/attachments/")) {
        throw new TypeError("network failed");
      }
      return new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "download-attachment-request",
      id: "d3",
      attachment_id: "attachment_abc",
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "download-attachment-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "download-attachment-result",
      id: "d3",
      ok: false,
      error: { code: "fetch_error" },
    });
  });

  it("replies with invalid_request when the request lacks attachment_id", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 }),
    );

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "download-attachment-request",
      id: "d4",
      // attachment_id is missing
    });
    await flushMicrotasks();

    const reply = iframePostSpy.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "download-attachment-result",
    );
    expect(reply).toBeTruthy();
    expect(reply![0]).toMatchObject({
      kind: "download-attachment-result",
      id: "d4",
      ok: false,
      error: { code: "invalid_request" },
    });

    // No download fetch should have been made — only the ws-ticket mint.
    const downloadCalls = fetchSpy.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" && (c[0] as string).includes("/attachments/"),
    );
    expect(downloadCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #298 phase 2 — record-mutate-request handler
// ---------------------------------------------------------------------------

describe("shell — record-mutate-request handler", () => {
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

  function findMutateReply(id: string):
    | {
        kind: string;
        id: string;
        ok: boolean;
        record?: unknown;
        error?: { code: string; message: string; details?: unknown };
      }
    | undefined {
    const c = iframePostSpy.mock.calls.find(
      (call) =>
        (call[0] as { kind?: string }).kind === "record-mutate-result" &&
        (call[0] as { id?: string }).id === id,
    );
    return c?.[0] as
      | {
          kind: string;
          id: string;
          ok: boolean;
          record?: unknown;
          error?: { code: string; message: string; details?: unknown };
        }
      | undefined;
  }

  const PERSISTED_RECORD = {
    id: "rec_x",
    collection: "comments",
    key: "cmt_1",
    data: { body: "hi" },
    version: 1,
    seq: 1,
    author: { kind: "human", id: "h_alice" },
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    deleted_at: null,
  };

  it("create: POSTs to /v1/.../records/:collection without record_key and replies ok:true with the row", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/records/comments")) {
        return new Response(JSON.stringify({ record: PERSISTED_RECORD }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ticket: "tkt_x" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "record-mutate-request",
      id: "m1",
      op: "create",
      collection: "comments",
      data: { body: "hi" },
    });
    await flushMicrotasks();

    const call = fetchSpy.mock.calls.find((c) =>
      (c[0] as string).includes("/records/comments"),
    );
    expect(call).toBeTruthy();
    expect(call![0] as string).toContain(
      `/v1/panes/${PANE_ID}/records/comments`,
    );
    const init = call![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ data: { body: "hi" } });
    // Authorization header carries the participant token from CFG.
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      CFG.wsTicketAuthorization,
    );

    const reply = findMutateReply("m1");
    expect(reply).toMatchObject({ ok: true, record: PERSISTED_RECORD });
  });

  it("upsert: POSTs with record_key in the body", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/records/comments")) {
        return new Response(JSON.stringify({ record: PERSISTED_RECORD }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ticket: "t" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "record-mutate-request",
      id: "m2",
      op: "upsert",
      collection: "comments",
      recordKey: "cmt_1",
      data: { body: "hi" },
    });
    await flushMicrotasks();

    const call = fetchSpy.mock.calls.find((c) =>
      (c[0] as string).includes("/records/comments"),
    );
    expect((call![1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      record_key: "cmt_1",
      data: { body: "hi" },
    });
    expect(findMutateReply("m2")).toMatchObject({ ok: true });
  });

  it("update: PATCHes /:recordKey with data + optional if_match", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/records/comments/cmt_1")) {
        return new Response(
          JSON.stringify({ record: { ...PERSISTED_RECORD, version: 2 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ticket: "t" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "record-mutate-request",
      id: "m3",
      op: "update",
      collection: "comments",
      recordKey: "cmt_1",
      data: { body: "v2" },
      ifMatch: 1,
    });
    await flushMicrotasks();

    const call = fetchSpy.mock.calls.find((c) =>
      (c[0] as string).includes("/records/comments/cmt_1"),
    );
    expect((call![1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      data: { body: "v2" },
      if_match: 1,
    });
    const reply = findMutateReply("m3");
    expect(reply?.ok).toBe(true);
    expect((reply!.record as { version: number }).version).toBe(2);
  });

  it("delete: DELETEs /:recordKey and replies ok:true on 204", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/records/comments/cmt_1")) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ ticket: "t" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "record-mutate-request",
      id: "m4",
      op: "delete",
      collection: "comments",
      recordKey: "cmt_1",
    });
    await flushMicrotasks();

    const call = fetchSpy.mock.calls.find((c) =>
      (c[0] as string).includes("/records/comments/cmt_1"),
    );
    expect((call![1] as RequestInit).method).toBe("DELETE");
    expect(findMutateReply("m4")).toMatchObject({ ok: true });
  });

  it("forwards the relay's error envelope on 4xx (with details for conflict)", async () => {
    const conflictBody = {
      error: {
        code: "conflict",
        message:
          "record version mismatch — current version is 5, caller passed if_match=2",
        details: { current: { ...PERSISTED_RECORD, version: 5 } },
      },
    };
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/records/comments/cmt_1")) {
        return new Response(JSON.stringify(conflictBody), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ticket: "t" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "record-mutate-request",
      id: "m5",
      op: "update",
      collection: "comments",
      recordKey: "cmt_1",
      data: { body: "x" },
      ifMatch: 2,
    });
    await flushMicrotasks();

    const reply = findMutateReply("m5");
    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        details: { current: { version: 5 } },
      },
    });
  });

  it("rejects with invalid_request on op='update' missing recordKey (no fetch fired)", async () => {
    fetchSpy.mockImplementation(async () => {
      return new Response(JSON.stringify({ ticket: "t" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "record-mutate-request",
      id: "m6",
      op: "update",
      collection: "comments",
      data: { body: "x" },
      // recordKey intentionally omitted
    });
    await flushMicrotasks();

    expect(findMutateReply("m6")).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    // No records fetch should have fired — only the ws-ticket mint.
    const recordsCalls = fetchSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/records/"),
    );
    expect(recordsCalls).toHaveLength(0);
  });

  it("rejects unknown ops with invalid_request", async () => {
    fetchSpy.mockImplementation(async () => {
      return new Response(JSON.stringify({ ticket: "t" }), { status: 200 });
    });

    dispatchFromIframe({
      __pane: 1,
      v: 1,
      kind: "record-mutate-request",
      id: "m7",
      op: "purge", // not a valid op
      collection: "comments",
    });
    await flushMicrotasks();

    expect(findMutateReply("m7")).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });
});
