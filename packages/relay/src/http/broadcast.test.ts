import { describe, it, expect } from "vitest";
import { openWaiter, publish, waitForEvent } from "./broadcast.js";
import type { SerializedEvent } from "../types.js";

function makeEvent(id: string, sessionId: string): SerializedEvent {
  return {
    id,
    session_id: sessionId,
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
    const sessionId = "ses_buffer";
    const waiter = openWaiter(sessionId);
    try {
      // Event arrives during the "query window" — after subscribe, before wait().
      publish(sessionId, makeEvent("1", sessionId));
      const got = await waiter.wait(50);
      expect(got?.id).toBe("1");
    } finally {
      waiter.close();
    }
  });

  it("blocks for the next event when nothing is buffered", async () => {
    const sessionId = "ses_block";
    const waiter = openWaiter(sessionId);
    try {
      const pending = waiter.wait(1000);
      publish(sessionId, makeEvent("2", sessionId));
      const got = await pending;
      expect(got?.id).toBe("2");
    } finally {
      waiter.close();
    }
  });

  it("resolves to null after the timeout when no event arrives", async () => {
    const sessionId = "ses_timeout";
    const waiter = openWaiter(sessionId);
    try {
      const got = await waiter.wait(10);
      expect(got).toBeNull();
    } finally {
      waiter.close();
    }
  });

  it("does not deliver after close()", async () => {
    const sessionId = "ses_closed";
    const waiter = openWaiter(sessionId);
    waiter.close();
    publish(sessionId, makeEvent("3", sessionId));
    const got = await waiter.wait(10);
    expect(got).toBeNull();
  });
});

describe("waitForEvent", () => {
  it("resolves to null after the timeout", async () => {
    const got = await waitForEvent("ses_none", 10);
    expect(got).toBeNull();
  });
});
