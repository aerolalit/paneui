import { describe, it, expect } from "vitest";
import { serializeEvent } from "./serialize.js";
import type { Event as EventRow } from "@prisma/client";

describe("serializeEvent", () => {
  it("converts numeric id to a string and flattens author", () => {
    const row: EventRow = {
      id: 42,
      paneId: "pan_x",
      authorKind: "human",
      authorId: "h_0",
      type: "review.commentAdded",
      data: { body: "hi" },
      causationId: null,
      idempotencyKey: null,
      ts: new Date("2026-05-13T10:00:00.000Z"),
      templateVersionId: "tv_abc",
      templateVersionNum: 3,
    };
    const s = serializeEvent(row);
    expect(s.id).toBe("42");
    expect(s.pane_id).toBe("pan_x");
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
      paneId: "pan_x",
      authorKind: "agent",
      authorId: "agent_1",
      type: "review.commentAdded",
      data: { body: "reply" },
      causationId: "42",
      idempotencyKey: "my-key-1",
      ts: new Date("2026-05-13T10:01:00.000Z"),
      templateVersionId: "tv_abc",
      templateVersionNum: 3,
    };
    const s = serializeEvent(row);
    expect(s.causation_id).toBe("42");
    expect(s.idempotency_key).toBe("my-key-1");
  });

  it("exposes template_version_id + template_version on the wire (#268)", () => {
    // Round-trip from the Event row's stamped pair to the wire fields a
    // downstream upgrade (#267) reads to render old events under the new
    // schema.
    const row: EventRow = {
      id: 7,
      paneId: "pan_x",
      authorKind: "agent",
      authorId: "agent_1",
      type: "feed.logged",
      data: { value: 1 },
      causationId: null,
      idempotencyKey: null,
      ts: new Date("2026-05-30T08:25:35.125Z"),
      templateVersionId: "cmpr1234567890abcdef",
      templateVersionNum: 9,
    };
    const s = serializeEvent(row);
    expect(s.template_version_id).toBe("cmpr1234567890abcdef");
    expect(s.template_version).toBe(9);
  });

  it("passes through nulls for events that pre-date the #268 stamp", () => {
    // The migration backfills most pre-#268 rows, but the schema keeps the
    // columns nullable so a TemplateVersion delete cascades SET NULL rather
    // than wiping the historical event row. The wire fields are therefore
    // `null` rather than absent, and consumers must handle that.
    const row: EventRow = {
      id: 1,
      paneId: "pan_x",
      authorKind: "system",
      authorId: "system",
      type: "system.participant.joined",
      data: { author: { kind: "agent", id: "agent_1" } },
      causationId: null,
      idempotencyKey: null,
      ts: new Date("2026-01-01T00:00:00.000Z"),
      templateVersionId: null,
      templateVersionNum: null,
    };
    const s = serializeEvent(row);
    expect(s.template_version_id).toBeNull();
    expect(s.template_version).toBeNull();
  });
});
