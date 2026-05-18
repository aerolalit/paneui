// @vitest-environment jsdom
//
// Unit test for the page-side `pane.*` shim. Executes the COMPILED bundle
// (dist/client/shim.client.js — produced by the pretest:unit `build:client`
// hook) inside a jsdom window. The shim is authored as a TS module; loadClient
// strips the `export {}` marker so the result runs as a classic script.
//
// In jsdom `window.parent === window`, so the shim's `parent.postMessage` and
// the `e.source !== parent` guard both resolve against this same window — we
// dispatch MessageEvents with `source: window` and spy on `postMessage`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadClient } from "./routes.js";

const SHIM_JS = loadClient("shim.client.js");

// The shim installs `window.pane` and a `message` listener. Each test needs a
// pristine instance, so we tear those down and re-run the bundle per test.
function freshShim(): void {
  // Remove a prior install's global so the new IIFE assigns cleanly
  // (window.pane is frozen, so delete rather than overwrite).
  delete (window as unknown as { pane?: unknown }).pane;
  new Function(SHIM_JS)();
}

describe("pane shim", () => {
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy BEFORE running the shim so the startup `ready` post is captured too.
    postSpy = vi.spyOn(window.parent, "postMessage");
    freshShim();
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
