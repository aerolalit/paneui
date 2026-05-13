import { describe, it, expect } from "vitest";
import { serializeEvent } from "./serialize.js";
import type { Event as EventRow } from "@prisma/client";

describe("serializeEvent", () => {
  it("converts numeric id to a string and flattens author", () => {
    const row: EventRow = {
      id: 42,
      sessionId: "ses_x",
      authorKind: "human",
      authorId: "h_0",
      type: "review.commentAdded",
      data: { body: "hi" },
      causationId: null,
      idempotencyKey: null,
      ts: new Date("2026-05-13T10:00:00.000Z"),
    };
    const s = serializeEvent(row);
    expect(s.id).toBe("42");
    expect(s.session_id).toBe("ses_x");
    expect(s.author).toEqual({ kind: "human", id: "h_0" });
    expect(s.ts).toBe("2026-05-13T10:00:00.000Z");
    expect(s.type).toBe("review.commentAdded");
    expect(s.data).toEqual({ body: "hi" });
    expect(s.causation_id).toBeNull();
    expect(s.idempotency_key).toBeNull();
  });

  it("preserves causation_id and idempotency_key when present", () => {
    const row: EventRow = {
      id: 100,
      sessionId: "ses_x",
      authorKind: "agent",
      authorId: "agent_1",
      type: "review.commentAdded",
      data: { body: "reply" },
      causationId: "42",
      idempotencyKey: "my-key-1",
      ts: new Date("2026-05-13T10:01:00.000Z"),
    };
    const s = serializeEvent(row);
    expect(s.causation_id).toBe("42");
    expect(s.idempotency_key).toBe("my-key-1");
  });
});
