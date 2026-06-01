import { describe, it, expect } from "vitest";
import { openWaiter, publish, waitForEvent } from "./broadcast.js";
import type { SerializedEvent } from "../types.js";

function makeEvent(id: string, paneId: string): SerializedEvent {
  return {
    id,
    pane_id: paneId,
    author: { kind: "agent", id: "a_0" },
    ts: new Date().toISOString(),
    type: "review.commentAdded",
    data: { body: "hi" },
    causation_id: null,
    idempotency_key: null,
  };
}

describe("openWaiter", () => {
  it("buffers an event published before wait() is called and delivers it", async () => {
    const paneId = "pan_buffer";
    const waiter = openWaiter(paneId);
    try {
      // Event arrives during the "query window" — after subscribe, before wait().
      publish(paneId, makeEvent("1", paneId));
      const got = await waiter.wait(50);
      expect(got?.id).toBe("1");
    } finally {
      waiter.close();
    }
  });

  it("blocks for the next event when nothing is buffered", async () => {
    const paneId = "pan_block";
    const waiter = openWaiter(paneId);
    try {
      const pending = waiter.wait(1000);
      publish(paneId, makeEvent("2", paneId));
      const got = await pending;
      expect(got?.id).toBe("2");
    } finally {
      waiter.close();
    }
  });

  it("resolves to null after the timeout when no event arrives", async () => {
    const paneId = "pan_timeout";
    const waiter = openWaiter(paneId);
    try {
      const got = await waiter.wait(10);
      expect(got).toBeNull();
    } finally {
      waiter.close();
    }
  });

  it("does not deliver after close()", async () => {
    const paneId = "pan_closed";
    const waiter = openWaiter(paneId);
    waiter.close();
    publish(paneId, makeEvent("3", paneId));
    const got = await waiter.wait(10);
    expect(got).toBeNull();
  });
});

describe("waitForEvent", () => {
  it("resolves to null after the timeout", async () => {
    const got = await waitForEvent("pan_none", 10);
    expect(got).toBeNull();
  });
});
