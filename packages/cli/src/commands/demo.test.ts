// Tests for `pane demo` — the reaction reducer, the watch/react loop, and an
// artifact smoke check. The loop is exercised through its dependency seams
// (a fake stream + fake sendEvent), so no relay or WebSocket is needed.

import { describe, it, expect, vi } from "vitest";
import type { PaneEvent, StreamHandlers, StreamHandle } from "@paneui/core";
import { demoReactions, runDemoLoop } from "./demo.js";
import { DEMO_ARTIFACT_HTML, DEMO_EVENT_SCHEMA } from "./demo-artifact.js";

// A minimal PaneEvent factory — only the fields the loop reads matter.
function ev(type: string, data: unknown = {}): PaneEvent {
  return {
    id: "evt_" + Math.random().toString(36).slice(2),
    pane_id: "pan_demo",
    author: { kind: "human", id: "h1" },
    ts: new Date().toISOString(),
    type,
    data,
    causation_id: null,
    idempotency_key: null,
    template_version_id: null,
    template_version: null,
  };
}

describe("demoReactions — the agent reaction table", () => {
  it("answers demo:start with advance to scene 2", () => {
    expect(demoReactions("demo:start")).toEqual([
      { type: "demo:advance", data: { scene: 2 } },
    ]);
  });

  it("answers demo:hello with advance to scene 3 (the proof beat)", () => {
    const out = demoReactions("demo:hello");
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("demo:advance");
    expect(out[0]!.data.scene).toBe(3);
    expect(typeof out[0]!.data.note).toBe("string");
  });

  it("answers demo:form by echoing the payload, then advancing, then done", () => {
    const out = demoReactions("demo:form", { name: "Sam", choice: "build" });
    expect(out.map((r) => r.type)).toEqual([
      "demo:echo",
      "demo:advance",
      "demo:done",
    ]);
    // The echo reflects the EXACT payload the human submitted.
    expect(out[0]!.data).toEqual({
      received: { name: "Sam", choice: "build" },
    });
    expect(out[1]!.data.scene).toBe(5);
    // Scenes 5 + 6 play as a narrated beat, not the same tick.
    expect(out[1]!.delayMs).toBeGreaterThan(0);
    expect(out[2]!.delayMs).toBeGreaterThan(out[1]!.delayMs!);
  });

  it("coerces a non-object demo:form payload to an empty received object", () => {
    const out = demoReactions("demo:form", "oops");
    expect(out[0]!.data).toEqual({ received: {} });
  });

  it("ignores agent-authored and unknown events", () => {
    expect(demoReactions("demo:advance")).toEqual([]);
    expect(demoReactions("demo:echo")).toEqual([]);
    expect(demoReactions("demo:done")).toEqual([]);
    expect(demoReactions("system.participant.joined")).toEqual([]);
    expect(demoReactions("anything.else")).toEqual([]);
  });
});

// A scriptable fake stream: hand it the StreamHandlers, then feed events.
function fakeStream() {
  let captured: StreamHandlers | undefined;
  const closed = { value: false };
  const openStreamImpl = ((_opts: unknown, handlers: StreamHandlers) => {
    captured = handlers;
    const handle: StreamHandle = {
      send: () => {},
      close: () => {
        closed.value = true;
      },
      socket: {} as StreamHandle["socket"],
    };
    return handle;
  }) as unknown as Parameters<typeof runDemoLoop>[0]["openStreamImpl"];
  return {
    openStreamImpl,
    closed,
    emit: (e: PaneEvent) => captured!.onEvent!(e),
    close: () => captured!.onClose!({ code: 1000, reason: "" }),
    relayError: (code: string, message: string) =>
      captured!.onRelayError!({ code, message }),
    error: (message: string) => captured!.onError!(new Error(message)),
    get handlers() {
      return captured!;
    },
  };
}

describe("runDemoLoop — the watch/react loop", () => {
  it("reacts to a full human sequence and finishes on demo:done", async () => {
    const sent: Array<{ type: string; data: unknown }> = [];
    const written: string[] = [];
    const deletePane = vi.fn(() => Promise.resolve());
    const stream = fakeStream();
    // Run delays synchronously so the scripted sequence completes in one tick.
    const schedule = (fn: () => void) => fn();

    const done = runDemoLoop({
      wsBaseUrl: "ws://x",
      paneId: "pan_demo",
      token: "tok",
      sendEvent: (type, data) => {
        sent.push({ type, data });
        return Promise.resolve();
      },
      deletePane,
      write: (s) => written.push(s),
      schedule,
      openStreamImpl: stream.openStreamImpl,
    });

    // Walk the tour the way a human would.
    stream.emit(ev("demo:start"));
    stream.emit(ev("demo:hello"));
    stream.emit(ev("demo:form", { name: "Sam", choice: "build" }));

    await done;

    // The agent reacted with the right sequence, in order.
    expect(sent.map((s) => s.type)).toEqual([
      "demo:advance", // <- demo:start
      "demo:advance", // <- demo:hello
      "demo:echo", // <- demo:form
      "demo:advance",
      "demo:done",
    ]);
    // The pane was best-effort deleted on exit.
    expect(deletePane).toHaveBeenCalledTimes(1);
    // The "build your own" snippet was printed.
    expect(written.join("")).toContain("pane create");
    expect(written.join("")).toContain("pane skill show");
    // The stream was closed.
    expect(stream.closed.value).toBe(true);
  });

  it("echoes every received HUMAN event to the terminal", async () => {
    const written: string[] = [];
    const stream = fakeStream();
    const done = runDemoLoop({
      wsBaseUrl: "ws://x",
      paneId: "pan_demo",
      token: "tok",
      sendEvent: () => Promise.resolve(),
      deletePane: () => Promise.resolve(),
      write: (s) => written.push(s),
      schedule: (fn) => fn(),
      openStreamImpl: stream.openStreamImpl,
    });
    stream.emit(ev("demo:hello"));
    stream.emit(ev("demo:form", { choice: "watch" }));
    stream.close();
    await done;
    const all = written.join("");
    expect(all).toContain("demo:hello");
    expect(all).toContain("demo:form");
    expect(all).toContain('"choice":"watch"');
  });

  it("does NOT echo or react to agent-authored events streamed back", async () => {
    const sent: string[] = [];
    const written: string[] = [];
    const stream = fakeStream();
    const done = runDemoLoop({
      wsBaseUrl: "ws://x",
      paneId: "pan_demo",
      token: "tok",
      sendEvent: (type) => {
        sent.push(type);
        return Promise.resolve();
      },
      deletePane: () => Promise.resolve(),
      write: (s) => written.push(s),
      schedule: (fn) => fn(),
      openStreamImpl: stream.openStreamImpl,
    });
    // The agent's own replies stream back too — they must be inert.
    stream.emit(ev("demo:advance", { scene: 2 }));
    stream.emit(ev("demo:echo", { received: {} }));
    stream.emit(ev("system.participant.joined", {}));
    stream.close();
    await done;
    expect(sent).toEqual([]);
    expect(written.join("")).not.toContain("demo:advance");
  });

  it("resolves cleanly if the session closes before completion", async () => {
    const deletePane = vi.fn(() => Promise.resolve());
    const written: string[] = [];
    const stream = fakeStream();
    const done = runDemoLoop({
      wsBaseUrl: "ws://x",
      paneId: "pan_demo",
      token: "tok",
      sendEvent: () => Promise.resolve(),
      deletePane,
      write: (s) => written.push(s),
      schedule: (fn) => fn(),
      openStreamImpl: stream.openStreamImpl,
    });
    stream.emit(ev("demo:start"));
    stream.close(); // human shut the tab early
    await done;
    expect(deletePane).toHaveBeenCalledTimes(1);
    expect(written.join("")).toContain("closed before completion");
  });

  it("surfaces a relay error and still cleans up", async () => {
    const deletePane = vi.fn(() => Promise.resolve());
    const written: string[] = [];
    const stream = fakeStream();
    const done = runDemoLoop({
      wsBaseUrl: "ws://x",
      paneId: "pan_demo",
      token: "tok",
      sendEvent: () => Promise.resolve(),
      deletePane,
      write: (s) => written.push(s),
      schedule: (fn) => fn(),
      openStreamImpl: stream.openStreamImpl,
    });
    stream.relayError("unauthorized", "bad key");
    await done;
    expect(written.join("")).toContain("relay error");
    expect(written.join("")).toContain("bad key");
    expect(deletePane).toHaveBeenCalledTimes(1);
  });
});

describe("demo artifact — smoke checks", () => {
  it("is a self-contained HTML document", () => {
    expect(DEMO_ARTIFACT_HTML).toMatch(/^<!doctype html>/i);
    expect(DEMO_ARTIFACT_HTML).toContain("</html>");
    // All six scenes are present.
    for (let s = 1; s <= 6; s++) {
      expect(DEMO_ARTIFACT_HTML).toContain(`data-scene="${s}"`);
    }
  });

  it("pulls in no external resources (CSP-clean)", () => {
    // No remote scripts, styles, fonts, or images — everything inline.
    expect(DEMO_ARTIFACT_HTML).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(DEMO_ARTIFACT_HTML).not.toMatch(/href\s*=\s*["']https?:\/\//i);
    expect(DEMO_ARTIFACT_HTML).not.toMatch(/<link\b/i);
    expect(DEMO_ARTIFACT_HTML).not.toContain("@import");
    // No network calls from inside the sandbox (connect-src 'none').
    expect(DEMO_ARTIFACT_HTML).not.toMatch(/\bfetch\s*\(/);
    expect(DEMO_ARTIFACT_HTML).not.toContain("XMLHttpRequest");
    // GSAP was explicitly ruled out — animation is CSS/WAAPI only.
    expect(DEMO_ARTIFACT_HTML.toLowerCase()).not.toContain("gsap");
  });

  it("only uses the documented pane.* runtime surface", () => {
    expect(DEMO_ARTIFACT_HTML).toContain("pane.emit(");
    expect(DEMO_ARTIFACT_HTML).toContain("pane.on(");
    expect(DEMO_ARTIFACT_HTML).toContain("pane.ready");
  });

  it("emits exactly the page events declared in the schema", () => {
    const pageTypes = Object.entries(DEMO_EVENT_SCHEMA.events)
      .filter(([, def]) =>
        (def.emittedBy as readonly string[]).includes("page"),
      )
      .map(([t]) => t);
    expect(new Set(pageTypes)).toEqual(
      new Set(["demo:start", "demo:hello", "demo:form"]),
    );
    for (const t of pageTypes) {
      expect(DEMO_ARTIFACT_HTML).toContain(`pane.emit("${t}"`);
    }
  });

  it("declares the agent events the loop sends", () => {
    const agentTypes = Object.entries(DEMO_EVENT_SCHEMA.events)
      .filter(([, def]) =>
        (def.emittedBy as readonly string[]).includes("agent"),
      )
      .map(([t]) => t);
    expect(new Set(agentTypes)).toEqual(
      new Set(["demo:advance", "demo:echo", "demo:done"]),
    );
  });
});
