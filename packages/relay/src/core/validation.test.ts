import { describe, it, expect, beforeEach } from "vitest";
import {
  validateEvent,
  validateSchemaShape,
  validateInputData,
  assertSchemaWithinLimits,
  mergeSchemaAdditive,
  invalidateSchemaCache,
  __schemaCacheInternals,
} from "./validation.js";
import type { EventSchema } from "../types.js";

const exampleSchema: EventSchema = {
  events: {
    "review.commentAdded": {
      payload: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      emittedBy: ["page", "agent"],
    },
    "review.approved": {
      payload: {
        type: "object",
        properties: { who: { type: "string" } },
        required: ["who"],
      },
      emittedBy: ["page"],
    },
    "highlight.requested": {
      payload: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
      emittedBy: ["agent"],
    },
  },
};

describe("validateSchemaShape", () => {
  it("accepts a well-formed schema", () => {
    const out = validateSchemaShape(exampleSchema);
    expect(Object.keys(out.events).sort()).toEqual([
      "highlight.requested",
      "review.approved",
      "review.commentAdded",
    ]);
  });

  it("rejects a schema with no events", () => {
    expect(() => validateSchemaShape({ events: {} })).toThrow();
  });

  it("rejects a non-namespaced type name (uppercase first char)", () => {
    expect(() =>
      validateSchemaShape({
        events: { Foo: { payload: { type: "object" }, emittedBy: ["page"] } },
      }),
    ).toThrow(/must match/);
  });

  it("rejects an empty emittedBy", () => {
    expect(() =>
      validateSchemaShape({
        events: { "x.y": { payload: { type: "object" }, emittedBy: [] } },
      }),
    ).toThrow(/emittedBy/);
  });

  it("rejects an emittedBy with an unknown kind", () => {
    expect(() =>
      validateSchemaShape({
        events: {
          "x.y": { payload: { type: "object" }, emittedBy: ["system"] },
        },
      }),
    ).toThrow(/'page' or 'agent'/);
  });

  it("rejects an invalid JSON Schema payload", () => {
    expect(() =>
      validateSchemaShape({
        events: {
          "x.y": { payload: { type: "not-a-real-type" }, emittedBy: ["page"] },
        },
      }),
    ).toThrow();
  });
});

describe("assertSchemaWithinLimits", () => {
  const limits = { maxBytes: 65_536, maxDepth: 32 };

  it("accepts a normal schema", () => {
    expect(() => assertSchemaWithinLimits(exampleSchema, limits)).not.toThrow();
  });

  it("rejects an over-size schema with a clear message", () => {
    // A schema whose serialized form exceeds the byte cap.
    const big = {
      events: {
        "x.y": {
          payload: { type: "object", description: "x".repeat(2_000) },
          emittedBy: ["page"],
        },
      },
    };
    expect(() =>
      assertSchemaWithinLimits(big, { maxBytes: 512, maxDepth: 32 }),
    ).toThrow(/too large.*MAX_SCHEMA_BYTES/);
  });

  it("rejects an over-deep schema with a clear message", () => {
    // Build a deeply-nested object well past the depth limit.
    let nested: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 50; i++) nested = { nested };
    expect(() =>
      assertSchemaWithinLimits(nested, { maxBytes: 65_536, maxDepth: 32 }),
    ).toThrow(/too deeply nested.*MAX_SCHEMA_DEPTH/);
  });

  it("rejects a schema with circular references", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => assertSchemaWithinLimits(circular, limits)).toThrow(
      /JSON-serializable/,
    );
  });
});

describe("validateEvent", () => {
  const args = {
    sessionId: "ses_test1",
    schemaVersion: 1,
    schema: exampleSchema,
  };

  it("accepts a valid payload from an allowed author kind", () => {
    expect(() =>
      validateEvent({
        ...args,
        type: "review.commentAdded",
        data: { body: "looks good" },
        authorKind: "human",
      }),
    ).not.toThrow();
    expect(() =>
      validateEvent({
        ...args,
        type: "review.commentAdded",
        data: { body: "good" },
        authorKind: "agent",
      }),
    ).not.toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      validateEvent({
        ...args,
        type: "not.a.type",
        data: {},
        authorKind: "human",
      }),
    ).toThrow(/unknown_event_type|unknown event/);
  });

  it("rejects a payload that fails the JSON Schema", () => {
    expect(() =>
      validateEvent({
        ...args,
        type: "review.commentAdded",
        data: { wrongField: 1 },
        authorKind: "human",
      }),
    ).toThrow(/schema_violation/);
  });

  it("rejects an author kind not in emittedBy", () => {
    // review.approved is page-only; an agent cannot emit it.
    expect(() =>
      validateEvent({
        ...args,
        type: "review.approved",
        data: { who: "me" },
        authorKind: "agent",
      }),
    ).toThrow(/cannot emit review.approved/);

    // highlight.requested is agent-only; a human cannot emit it.
    expect(() =>
      validateEvent({
        ...args,
        type: "highlight.requested",
        data: { selector: "#p1" },
        authorKind: "human",
      }),
    ).toThrow(/cannot emit highlight.requested/);
  });

  it("treats author_kind 'system' as bypassing emittedBy", () => {
    expect(() =>
      validateEvent({
        ...args,
        type: "review.commentAdded",
        data: { body: "system note" },
        authorKind: "system",
      }),
    ).not.toThrow();
  });

  // View-only artifact: a session with no event schema declares an empty,
  // strictly-enforced vocabulary — every page/agent emit is rejected.
  // The error's `code`/`message` is `unknown_event_type`; the view-only
  // explanation rides in the `hint`.
  it("rejects an agent emit on a schemaless (view-only) session", () => {
    let caught: { code: string; hint: string } | undefined;
    try {
      validateEvent({
        sessionId: "ses_viewonly",
        schemaVersion: 1,
        schema: null,
        type: "anything.atall",
        data: {},
        authorKind: "agent",
      });
    } catch (e) {
      caught = e as { code: string; hint: string };
    }
    expect(caught?.code).toBe("unknown_event_type");
    expect(caught?.hint).toMatch(/view-only and accepts no page\/agent events/);
  });

  it("rejects a human emit on a schemaless (view-only) session", () => {
    let caught: { code: string; hint: string } | undefined;
    try {
      validateEvent({
        sessionId: "ses_viewonly",
        schemaVersion: 1,
        schema: null,
        type: "anything.atall",
        data: {},
        authorKind: "human",
      });
    } catch (e) {
      caught = e as { code: string; hint: string };
    }
    expect(caught?.code).toBe("unknown_event_type");
    expect(caught?.hint).toMatch(/view-only and accepts no page\/agent events/);
  });

  it("does NOT reject a system event on a schemaless session", () => {
    // System events bypass the view-only guard — they keep flowing so
    // system.session.expired, participant.joined, etc. still work.
    expect(() =>
      validateEvent({
        sessionId: "ses_viewonly",
        schemaVersion: 1,
        schema: null,
        type: "system.note",
        data: {},
        authorKind: "system",
      }),
    ).not.toThrow();
  });
});

describe("mergeSchemaAdditive", () => {
  it("adds a new event type", () => {
    const next = mergeSchemaAdditive(exampleSchema, {
      events: {
        "review.rejected": {
          payload: {
            type: "object",
            properties: { reason: { type: "string" } },
          },
          emittedBy: ["page"],
        },
      },
    });
    expect(next.events["review.rejected"]).toBeDefined();
    expect(next.events["review.commentAdded"]).toBeDefined();
  });

  it("rejects re-declaring an existing event type", () => {
    const prev: EventSchema = {
      events: {
        "review.commentAdded": {
          payload: { type: "object" },
          emittedBy: ["page"],
        },
        "review.approved": { payload: { type: "object" }, emittedBy: ["page"] },
      },
    };
    // Even an "identical" re-declaration is rejected — additive only.
    expect(() =>
      mergeSchemaAdditive(prev, {
        events: {
          "review.commentAdded": prev.events[
            "review.commentAdded"
          ]! as unknown as Record<string, unknown>,
        },
      }),
    ).toThrow(/already exists/);
  });

  it("keeps prior types when the patch adds only new ones", () => {
    const prev: EventSchema = {
      events: {
        "review.commentAdded": {
          payload: { type: "object" },
          emittedBy: ["page"],
        },
        "review.approved": { payload: { type: "object" }, emittedBy: ["page"] },
      },
    };
    const next = mergeSchemaAdditive(prev, {
      events: {
        "review.rejected": { payload: { type: "object" }, emittedBy: ["page"] },
      },
    });
    expect(next.events["review.commentAdded"]).toBeDefined();
    expect(next.events["review.approved"]).toBeDefined();
    expect(next.events["review.rejected"]).toBeDefined();
  });
});

describe("compiled-validator cache (LRU)", () => {
  const schema: EventSchema = {
    events: {
      "x.event": { payload: { type: "object" }, emittedBy: ["agent"] },
    },
  };
  // Validating an event for a session populates the cache for that
  // (sessionId, schemaVersion) key.
  const touch = (sessionId: string): void =>
    validateEvent({
      sessionId,
      schemaVersion: 1,
      schema,
      type: "x.event",
      data: {},
      authorKind: "agent",
    });

  beforeEach(() => __schemaCacheInternals.clear());

  it("caches a compiled validator per session", () => {
    touch("s1");
    expect(__schemaCacheInternals.has("s1", 1)).toBe(true);
    expect(__schemaCacheInternals.size()).toBe(1);
  });

  it("invalidateSchemaCache drops a session's entries", () => {
    touch("s1");
    invalidateSchemaCache("s1");
    expect(__schemaCacheInternals.has("s1", 1)).toBe(false);
  });

  it("evicts the least-recently-used entry once over CACHE_MAX", () => {
    const max = __schemaCacheInternals.max;
    // Fill the cache exactly to capacity.
    for (let i = 0; i < max; i++) touch(`sess_${i}`);
    expect(__schemaCacheInternals.size()).toBe(max);

    // Re-touch the oldest entry so it is no longer the LRU.
    touch("sess_0");
    // One more distinct session pushes the cache over cap → one eviction.
    touch("overflow");

    expect(__schemaCacheInternals.size()).toBe(max);
    // sess_0 was refreshed, so sess_1 is now the LRU and gets evicted.
    expect(__schemaCacheInternals.has("sess_0", 1)).toBe(true);
    expect(__schemaCacheInternals.has("sess_1", 1)).toBe(false);
    expect(__schemaCacheInternals.has("overflow", 1)).toBe(true);
  });
});

describe("validateInputData", () => {
  const inputSchema = {
    type: "object",
    properties: {
      prTitle: { type: "string" },
      diffUrl: { type: "string" },
    },
    required: ["prTitle"],
    additionalProperties: false,
  };

  it("accepts input_data that satisfies the schema", () => {
    expect(() =>
      validateInputData(inputSchema, { prTitle: "Fix the bug" }),
    ).not.toThrow();
  });

  it("rejects input_data missing a required field", () => {
    expect(() => validateInputData(inputSchema, {})).toThrow();
  });

  it("rejects input_data with an unexpected property", () => {
    expect(() =>
      validateInputData(inputSchema, { prTitle: "x", bogus: 1 }),
    ).toThrow();
  });

  it("rejects input_data with a wrong-typed field", () => {
    expect(() => validateInputData(inputSchema, { prTitle: 123 })).toThrow();
  });

  it("throws a 422 schema-violation with details on mismatch", () => {
    try {
      validateInputData(inputSchema, {});
      expect.unreachable("validateInputData should have thrown");
    } catch (err) {
      const e = err as {
        status?: number;
        code?: string;
        details?: unknown;
      };
      expect(e.status).toBe(422);
      expect(e.code).toBe("input_schema_violation");
      expect(e.details).toBeTruthy();
    }
  });

  it("throws a 400 when given a malformed JSON Schema", () => {
    try {
      validateInputData({ type: "not-a-real-type" }, { prTitle: "x" });
      expect.unreachable("validateInputData should have thrown");
    } catch (err) {
      const e = err as { status?: number };
      expect(e.status).toBe(400);
    }
  });
});
