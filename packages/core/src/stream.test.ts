// Unit tests for openStream's frame routing — in particular that malformed
// and unrecognized frames are surfaced via onError rather than dropped (C2).
//
// openStream opens a real `ws` socket, but we never let it connect: we grab
// the underlying socket (an EventEmitter) and emit "message" frames directly,
// which drives the exact handler under test.

import { describe, it, expect, afterEach } from "vitest";
import { openStream, type StreamHandle } from "./stream.js";

let handles: StreamHandle[] = [];

function open(handlers: Parameters<typeof openStream>[1]): StreamHandle {
  // Point at a non-routable address so no real connection ever establishes.
  const h = openStream(
    { wsBaseUrl: "ws://127.0.0.1:0", surfaceId: "ses_x", token: "k" },
    handlers,
  );
  // Swallow the inevitable connection-failure error (no server listening) so
  // it doesn't surface as an unhandled exception.
  h.socket.on("error", () => {});
  handles.push(h);
  return h;
}

afterEach(() => {
  for (const h of handles) {
    h.socket.on("error", () => {});
    try {
      h.socket.close();
    } catch {
      /* noop */
    }
  }
  handles = [];
});

describe("openStream frame routing", () => {
  it("routes a JSON parse failure to onError with a snippet", () => {
    let err: Error | undefined;
    const h = open({ onError: (e) => (err = e) });
    h.socket.emit("message", Buffer.from("{not json"));
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("failed to parse stream frame");
    expect(err!.message).toContain("{not json");
  });

  it("routes an unrecognized frame shape to onError", () => {
    let err: Error | undefined;
    const h = open({ onError: (e) => (err = e) });
    h.socket.emit("message", Buffer.from(JSON.stringify({ surprise: true })));
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("unrecognized stream frame");
  });

  it("delivers a well-formed event envelope to onEvent", () => {
    const events: unknown[] = [];
    const h = open({ onEvent: (e) => events.push(e) });
    const env = { id: "evt_1", type: "form.submitted", surface_id: "ses_x" };
    h.socket.emit("message", Buffer.from(JSON.stringify(env)));
    expect(events).toHaveLength(1);
    expect((events[0] as { id: string }).id).toBe("evt_1");
  });

  it("fires onReplayComplete for the replay marker", () => {
    let done = false;
    const h = open({ onReplayComplete: () => (done = true) });
    h.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ kind: "system.replay.complete" })),
    );
    expect(done).toBe(true);
  });

  it("routes a relay error frame to onRelayError", () => {
    let code: string | undefined;
    const h = open({ onRelayError: (e) => (code = e.code) });
    h.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ error: { code: "bad" } })),
    );
    expect(code).toBe("bad");
  });
});

describe("StreamHandle.send", () => {
  it("throws when the socket is not open", () => {
    const h = open({});
    // Socket has not connected, so readyState !== OPEN.
    expect(() => h.send({ type: "agent.hint" })).toThrow(/socket is not open/);
  });
});
