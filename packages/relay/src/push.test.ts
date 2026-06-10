// Unit tests for the per-human push coalescer and the aggregate-payload
// builder. The coalescer is timer-driven, so these use fake timers and a fake
// send sink — no web-push, Prisma or config involved.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createPushCoalescer,
  aggregatePayloads,
  type PushPayload,
} from "./push.js";

afterEach(() => {
  vi.useRealTimers();
});

function payload(n: number): PushPayload {
  return {
    title: `Pane ${n}`,
    body: "Agent created a new pane",
    paneUrl: `https://relay.example/panes/p${n}`,
  };
}

describe("createPushCoalescer", () => {
  it("sends the first notification immediately (leading edge)", () => {
    vi.useFakeTimers();
    const sent: Array<{ humanId: string; payload: PushPayload }> = [];
    const c = createPushCoalescer(60_000, (humanId, p) =>
      sent.push({ humanId, payload: p }),
    );

    c.submit("alice", payload(1));
    // No timer advance — the leading edge is synchronous.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.humanId).toBe("alice");
    expect(sent[0]!.payload.title).toBe("Pane 1");
  });

  it("coalesces a burst into a single aggregate after the window", () => {
    vi.useFakeTimers();
    const sent: PushPayload[] = [];
    const c = createPushCoalescer(60_000, (_h, p) => sent.push(p));

    c.submit("alice", payload(1)); // leading edge — sends now
    c.submit("alice", payload(2)); // buffered
    c.submit("alice", payload(3)); // buffered
    expect(sent).toHaveLength(1); // only the leading edge so far

    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(2); // aggregate flush
    expect(sent[1]!.title).toBe("2 new panes"); // panes 2 and 3
    expect(sent[1]!.body).toBe("Pane 2, Pane 3");
    // Aggregate deep-links to the most recent pane in the batch.
    expect(sent[1]!.paneUrl).toBe("https://relay.example/panes/p3");
  });

  it("re-arms the window while the human stays active, then closes when quiet", () => {
    vi.useFakeTimers();
    const sent: PushPayload[] = [];
    const c = createPushCoalescer(60_000, (_h, p) => sent.push(p));

    c.submit("alice", payload(1)); // leading edge
    c.submit("alice", payload(2)); // buffered for window 1
    vi.advanceTimersByTime(60_000); // flush -> aggregate (1), re-arm window
    expect(sent).toHaveLength(2);

    c.submit("alice", payload(3)); // buffered for the re-armed window
    vi.advanceTimersByTime(60_000); // flush -> single (pane 3), re-arm window
    expect(sent).toHaveLength(3);
    expect(sent[2]!.title).toBe("Pane 3"); // single buffered item, not aggregated

    // Quiet window closes the throttle; the next submit is a fresh leading edge.
    vi.advanceTimersByTime(60_000);
    c.submit("alice", payload(4));
    expect(sent).toHaveLength(4);
    expect(sent[3]!.title).toBe("Pane 4");
  });

  it("throttles each human independently", () => {
    vi.useFakeTimers();
    const sent: Array<{ humanId: string; title: string }> = [];
    const c = createPushCoalescer(60_000, (humanId, p) =>
      sent.push({ humanId, title: p.title }),
    );

    c.submit("alice", payload(1)); // alice leading edge
    c.submit("bob", payload(2)); // bob leading edge (independent)
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.humanId)).toEqual(["alice", "bob"]);
  });

  it("does not aggregate a window that only saw the leading edge", () => {
    vi.useFakeTimers();
    const sent: PushPayload[] = [];
    const c = createPushCoalescer(60_000, (_h, p) => sent.push(p));

    c.submit("alice", payload(1));
    vi.advanceTimersByTime(60_000); // empty window — closes, no flush
    expect(sent).toHaveLength(1);
  });
});

describe("aggregatePayloads", () => {
  it("counts panes and lists up to three titles", () => {
    const agg = aggregatePayloads([payload(1), payload(2)]);
    expect(agg.title).toBe("2 new panes");
    expect(agg.body).toBe("Pane 1, Pane 2");
    expect(agg.paneUrl).toBe("https://relay.example/panes/p2");
  });

  it("truncates the title list past three with a +N more suffix", () => {
    const agg = aggregatePayloads([1, 2, 3, 4, 5].map(payload));
    expect(agg.title).toBe("5 new panes");
    expect(agg.body).toBe("Pane 1, Pane 2, Pane 3, +2 more");
    expect(agg.paneUrl).toBe("https://relay.example/panes/p5");
  });

  it("falls back to a generic body when no titles are present", () => {
    const blank: PushPayload[] = [
      { title: "", paneUrl: "https://relay.example/panes/pa" },
      { title: "   ", paneUrl: "https://relay.example/panes/pb" },
    ];
    const agg = aggregatePayloads(blank);
    expect(agg.title).toBe("2 new panes");
    expect(agg.body).toBe("2 new panes created");
    expect(agg.paneUrl).toBe("https://relay.example/panes/pb");
  });
});
