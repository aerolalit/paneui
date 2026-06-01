import { describe, it, expect, beforeEach } from "vitest";
import {
  validateEvent,
  validateSchemaShape,
  validateRecordSchemaShape,
  validateInputData,
  validateSessionTitle,
  validateSessionPreamble,
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

describe("validateSchemaShape — standards-aligned x-pane-events (#300)", () => {
  // The standards-aligned shape normalizes to the SAME internal EventSchema
  // the legacy bespoke shape produces, so every downstream consumer
  // (validateEvent, schema-compat, etc.) is unchanged. These tests pin the
  // discriminator + the normalization.

  const STANDARDS_VALID = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: {
      ReviewSubmitted: {
        type: "object",
        properties: { rating: { type: "integer" } },
        required: ["rating"],
      },
    },
    "x-pane-events": {
      "review.submitted": {
        payload: { $ref: "#/$defs/ReviewSubmitted" },
        emit: ["page"],
      },
    },
  };

  it("accepts the minimal standards shape and normalizes to the same EventSchema as the legacy form", () => {
    const out = validateSchemaShape(STANDARDS_VALID);
    expect(Object.keys(out.events)).toEqual(["review.submitted"]);
    expect(out.events["review.submitted"]!.emittedBy).toEqual(["page"]);
    // The internal payload IS the resolved row schema (the $defs target),
    // not the $ref wrapper. Downstream Ajv compiles against this directly.
    expect(out.events["review.submitted"]!.payload).toEqual(
      STANDARDS_VALID.$defs.ReviewSubmitted,
    );
  });

  it("standards + legacy produce identical EventSchema for an equivalent declaration", () => {
    const standards = validateSchemaShape(STANDARDS_VALID);
    const legacy = validateSchemaShape({
      events: {
        "review.submitted": {
          payload: STANDARDS_VALID.$defs.ReviewSubmitted,
          emittedBy: ["page"],
        },
      },
    });
    expect(standards).toEqual(legacy);
  });

  it("accepts an inline payload (no $ref) — terse single-use", () => {
    const out = validateSchemaShape({
      "x-pane-events": {
        "form.submitted": {
          payload: { type: "object", required: ["body"] },
          emit: ["page", "agent"],
        },
      },
    });
    expect(out.events["form.submitted"]!.payload).toEqual({
      type: "object",
      required: ["body"],
    });
    expect(out.events["form.submitted"]!.emittedBy).toEqual(["page", "agent"]);
  });

  it("rejects mixing legacy `events` with `x-pane-events` (choose one)", () => {
    expect(() =>
      validateSchemaShape({
        events: { foo: {} },
        "x-pane-events": {
          "foo.bar": {
            payload: { type: "object" },
            emit: ["page"],
          },
        },
      }),
    ).toThrow(/cannot mix/);
  });

  it("rejects an unknown top-level key", () => {
    expect(() =>
      validateSchemaShape({
        ...STANDARDS_VALID,
        nonsense: 1,
      }),
    ).toThrow(/unknown top-level key 'nonsense'/);
  });

  it("rejects an empty x-pane-events", () => {
    expect(() => validateSchemaShape({ "x-pane-events": {} })).toThrow(
      /at least one event type/,
    );
  });

  it("rejects a $ref that doesn't resolve under $defs", () => {
    expect(() =>
      validateSchemaShape({
        $defs: {},
        "x-pane-events": {
          "x.y": {
            payload: { $ref: "#/$defs/Missing" },
            emit: ["page"],
          },
        },
      }),
    ).toThrow(/does not resolve under \$defs/);
  });

  it("rejects a cross-doc $ref (anything not #/$defs/<Name>)", () => {
    expect(() =>
      validateSchemaShape({
        $defs: {},
        "x-pane-events": {
          "x.y": {
            payload: { $ref: "https://example.com/Schema.json" },
            emit: ["page"],
          },
        },
      }),
    ).toThrow(/must match '#\/\$defs\/<Name>'/);
  });

  it("rejects an unknown principal in emit", () => {
    expect(() =>
      validateSchemaShape({
        "x-pane-events": {
          "x.y": {
            payload: { type: "object" },
            emit: ["everyone"],
          },
        },
      }),
    ).toThrow(/'page' or 'agent'/);
  });

  it("rejects an empty emit array", () => {
    expect(() =>
      validateSchemaShape({
        "x-pane-events": {
          "x.y": {
            payload: { type: "object" },
            emit: [],
          },
        },
      }),
    ).toThrow(/non-empty array/);
  });

  it("rejects an unknown entry sub-key", () => {
    expect(() =>
      validateSchemaShape({
        "x-pane-events": {
          "x.y": {
            payload: { type: "object" },
            emit: ["page"],
            extra: 1,
          },
        },
      }),
    ).toThrow(/unknown key 'extra'/);
  });

  it("rejects a non-namespaced event type", () => {
    expect(() =>
      validateSchemaShape({
        "x-pane-events": {
          Foo: { payload: { type: "object" }, emit: ["page"] },
        },
      }),
    ).toThrow(/must match/);
  });

  it("rejects a payload that doesn't compile as JSON Schema 2020-12", () => {
    expect(() =>
      validateSchemaShape({
        "x-pane-events": {
          "x.y": {
            payload: { type: "not-a-real-type" },
            emit: ["page"],
          },
        },
      }),
    ).toThrow(/not a valid JSON Schema 2020-12/);
  });

  it("deduplicates emit entries (same as legacy emittedBy)", () => {
    const out = validateSchemaShape({
      "x-pane-events": {
        "x.y": {
          payload: { type: "object" },
          emit: ["page", "page", "agent"],
        },
      },
    });
    expect(out.events["x.y"]!.emittedBy).toEqual(["page", "agent"]);
  });
});

describe("validateRecordSchemaShape", () => {
  // Minimal valid recordSchema reused across the happy-path + rejection cases.
  const validDoc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: {
      Comment: {
        type: "object",
        properties: { body: { type: "string", maxLength: 4000 } },
        required: ["body"],
      },
    },
    "x-pane-collections": {
      comments: {
        schema: { $ref: "#/$defs/Comment" },
        write: ["page"],
        delete: ["author"],
      },
    },
  };

  it("accepts a minimal valid recordSchema", () => {
    expect(() => validateRecordSchemaShape(validDoc)).not.toThrow();
  });

  it("accepts a richer recordSchema with multiple collections + all principal kinds", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: {
          Post: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
          Comment: {
            type: "object",
            properties: { body: { type: "string" } },
          },
        },
        "x-pane-collections": {
          posts: {
            schema: { $ref: "#/$defs/Post" },
            write: ["agent", "page"],
            delete: ["agent", "page", "author"],
          },
          comments: {
            schema: { $ref: "#/$defs/Comment" },
            write: ["page"],
            delete: ["author"],
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => validateRecordSchemaShape(null)).toThrow(/must be an object/);
    expect(() => validateRecordSchemaShape([])).toThrow(/must be an object/);
    expect(() => validateRecordSchemaShape("hello")).toThrow(
      /must be an object/,
    );
  });

  it("rejects an unknown top-level key", () => {
    expect(() =>
      validateRecordSchemaShape({
        ...validDoc,
        events: { "foo.bar": {} },
      }),
    ).toThrow(/unknown top-level key 'events'/);
  });

  it("rejects missing x-pane-collections", () => {
    expect(() => validateRecordSchemaShape({ $defs: validDoc.$defs })).toThrow(
      /x-pane-collections.* is required/,
    );
  });

  it("rejects empty x-pane-collections", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {},
      }),
    ).toThrow(/must declare at least one collection/);
  });

  it("rejects an unknown sub-key under a collection entry", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          comments: {
            schema: { $ref: "#/$defs/Comment" },
            write: ["page"],
            delete: ["author"],
            unknownKey: true,
          },
        },
      }),
    ).toThrow(/unknown key 'unknownKey'/);
  });

  it("rejects an unknown principal in write", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          comments: {
            schema: { $ref: "#/$defs/Comment" },
            write: ["everyone"],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/write values must be/);
  });

  it("rejects 'author' in write (only valid in delete)", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          comments: {
            schema: { $ref: "#/$defs/Comment" },
            write: ["author"],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/write values must be 'agent' or 'page'/);
  });

  it("rejects an unknown principal in delete", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          comments: {
            schema: { $ref: "#/$defs/Comment" },
            write: ["page"],
            delete: ["everyone"],
          },
        },
      }),
    ).toThrow(/delete values must be/);
  });

  it("rejects an empty write array", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          comments: {
            schema: { $ref: "#/$defs/Comment" },
            write: [],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/write must be a non-empty array/);
  });

  it("rejects a $ref that does not resolve under $defs", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          comments: {
            schema: { $ref: "#/$defs/Missing" },
            write: ["page"],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/does not resolve under \$defs/);
  });

  it("rejects a cross-doc $ref (anything not under #/$defs/...)", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          comments: {
            schema: { $ref: "https://example.com/Comment.json" },
            write: ["page"],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/must match '#\/\$defs\/<Name>'/);
  });

  it("rejects a row schema under $defs that doesn't compile as JSON Schema", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: { Bad: { type: "not-a-real-type" } },
        "x-pane-collections": {
          comments: {
            schema: { $ref: "#/$defs/Bad" },
            write: ["page"],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/does not compile as JSON Schema 2020-12/);
  });

  it("rejects a collection name with uppercase", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          Comments: {
            schema: { $ref: "#/$defs/Comment" },
            write: ["page"],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/collection name 'Comments' must match/);
  });

  it("rejects a collection name starting with a digit", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          "1comments": {
            schema: { $ref: "#/$defs/Comment" },
            write: ["page"],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/must match/);
  });

  it("rejects a collection name longer than 64 chars", () => {
    const longName = "a".repeat(65);
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          [longName]: {
            schema: { $ref: "#/$defs/Comment" },
            write: ["page"],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/must match/);
  });

  it("rejects a missing schema.$ref", () => {
    expect(() =>
      validateRecordSchemaShape({
        $defs: validDoc.$defs,
        "x-pane-collections": {
          comments: {
            schema: {},
            write: ["page"],
            delete: ["author"],
          },
        },
      }),
    ).toThrow(/\$ref is required and must be a string/);
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
    paneId: "pan_test1",
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

  it("schema_violation details lists ALL failing fields, not just the first (#137)", () => {
    // Multi-field schema in a one-off pane so we can violate two
    // constraints simultaneously and verify both are surfaced.
    const multiFieldSchema: EventSchema = {
      events: {
        "form.submitted": {
          payload: {
            type: "object",
            properties: {
              name: { type: "string" },
              n: { type: "integer" },
            },
            required: ["name", "n"],
            additionalProperties: false,
          },
          emittedBy: ["page"],
        },
      },
    };
    try {
      validateEvent({
        paneId: "pan_multi",
        schemaVersion: 1,
        schema: multiFieldSchema,
        type: "form.submitted",
        // name should be string (sending number); n should be integer
        // (sending string). Pre-Ajv-allErrors only the first one surfaced.
        data: { name: 42, n: "oops" },
        authorKind: "human",
      });
      expect.unreachable("validateEvent should have thrown");
    } catch (err) {
      const e = err as { details?: unknown[] };
      expect(Array.isArray(e.details)).toBe(true);
      expect(e.details!.length).toBeGreaterThanOrEqual(2);
    }
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

  // View-only template: a pane with no event schema declares an empty,
  // strictly-enforced vocabulary — every page/agent emit is rejected.
  // The error's `code`/`message` is `unknown_event_type`; the view-only
  // explanation rides in the `hint`.
  it("rejects an agent emit on a schemaless (view-only) pane", () => {
    let caught: { code: string; hint: string } | undefined;
    try {
      validateEvent({
        paneId: "pan_viewonly",
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

  it("rejects a human emit on a schemaless (view-only) pane", () => {
    let caught: { code: string; hint: string } | undefined;
    try {
      validateEvent({
        paneId: "pan_viewonly",
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

  it("does NOT reject a system event on a schemaless pane", () => {
    // System events bypass the view-only guard — they keep flowing so
    // system.pane.expired, participant.joined, etc. still work.
    expect(() =>
      validateEvent({
        paneId: "pan_viewonly",
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
  // Validating an event for a pane populates the cache for that
  // (paneId, schemaVersion) key.
  const touch = (paneId: string): void =>
    validateEvent({
      paneId,
      schemaVersion: 1,
      schema,
      type: "x.event",
      data: {},
      authorKind: "agent",
    });

  beforeEach(() => __schemaCacheInternals.clear());

  it("caches a compiled validator per pane", () => {
    touch("s1");
    expect(__schemaCacheInternals.has("s1", 1)).toBe(true);
    expect(__schemaCacheInternals.size()).toBe(1);
  });

  it("invalidateSchemaCache drops a pane's entries", () => {
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
    // One more distinct pane pushes the cache over cap → one eviction.
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

  it("reports ALL failing fields, not just the first (#137)", () => {
    // Two simultaneous violations: prTitle is the wrong type AND diffUrl is
    // the wrong type. Pre-fix (Ajv default allErrors:false) Ajv short-
    // circuits and details has length 1 — caller has to fix-and-retry one
    // field at a time. After the fix details lists both.
    const schema = {
      type: "object",
      properties: {
        prTitle: { type: "string" },
        diffUrl: { type: "string" },
      },
      required: ["prTitle", "diffUrl"],
      additionalProperties: false,
    };
    try {
      validateInputData(schema, { prTitle: 42, diffUrl: 99 });
      expect.unreachable("validateInputData should have thrown");
    } catch (err) {
      const e = err as { details?: unknown[] };
      expect(Array.isArray(e.details)).toBe(true);
      expect(e.details!.length).toBeGreaterThanOrEqual(2);
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

describe("format: pane-attachment-id", () => {
  const schemaWithBlobRef: EventSchema = {
    events: {
      "image.attach": {
        emittedBy: ["page", "agent"],
        payload: {
          type: "object",
          properties: {
            attachment: {
              type: "object",
              properties: {
                attachment_id: {
                  type: "string",
                  format: "pane-attachment-id",
                },
              },
              required: ["attachment_id"],
            },
          },
          required: ["attachment"],
        },
      },
    },
  };

  const baseArgs = {
    paneId: "pan_blob_format",
    schemaVersion: 1,
    schema: schemaWithBlobRef,
    type: "image.attach",
    authorKind: "agent" as const,
  };

  it("accepts a cuid-shaped attachment_id", () => {
    expect(() =>
      validateEvent({
        ...baseArgs,
        data: { attachment: { attachment_id: "cmpel3zb30000k923tf77pjrw" } },
      }),
    ).not.toThrow();
  });

  it("rejects a non-cuid string", () => {
    try {
      validateEvent({
        ...baseArgs,
        data: { attachment: { attachment_id: "not-a-cuid" } },
      });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as { status?: number; code?: string };
      expect(e.status).toBe(422);
      expect(e.code).toBe("schema_violation");
    }
  });

  it("rejects empty / missing attachment_id", () => {
    expect(() =>
      validateEvent({
        ...baseArgs,
        data: { attachment: { attachment_id: "" } },
      }),
    ).toThrow();
    expect(() =>
      validateEvent({
        ...baseArgs,
        data: { attachment: {} },
      }),
    ).toThrow();
  });

  it("rejects wrong type for attachment_id (e.g. number)", () => {
    expect(() =>
      validateEvent({
        ...baseArgs,
        data: { attachment: { attachment_id: 12345 } },
      }),
    ).toThrow();
  });
});

describe("validateSessionTitle", () => {
  it("returns the trimmed string for a valid title", () => {
    expect(validateSessionTitle("Quarterly Review")).toBe("Quarterly Review");
    expect(validateSessionTitle("  padded  ")).toBe("padded");
  });

  it("rejects non-string input with a 400", () => {
    for (const v of [undefined, null, 42, true, [], {}]) {
      try {
        validateSessionTitle(v);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as { status?: number }).status).toBe(400);
      }
    }
  });

  it("rejects an empty / whitespace-only title", () => {
    for (const v of ["", "   ", "\t\t"]) {
      try {
        validateSessionTitle(v);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as { status?: number }).status).toBe(400);
      }
    }
  });

  it("rejects titles longer than 80 chars (post-trim)", () => {
    try {
      validateSessionTitle("a".repeat(81));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
    }
    // 80 is fine.
    expect(validateSessionTitle("a".repeat(80))).toBe("a".repeat(80));
  });

  it("rejects ASCII control chars (incl. newline, tab, CR)", () => {
    for (const v of ["line\nbreak", "tab\there", "ret\rurn", "nul\x00byte"]) {
      try {
        validateSessionTitle(v);
        expect.unreachable("should have thrown for: " + JSON.stringify(v));
      } catch (err) {
        expect((err as { status?: number }).status).toBe(400);
      }
    }
  });

  it("accepts unicode (non-control) just fine", () => {
    expect(validateSessionTitle("Quarterly Review · Pane")).toBe(
      "Quarterly Review · Pane",
    );
    expect(validateSessionTitle("会議メモ")).toBe("会議メモ");
  });
});

describe("validateSessionPreamble", () => {
  it("returns null for undefined / null / empty / whitespace-only", () => {
    expect(validateSessionPreamble(undefined)).toBeNull();
    expect(validateSessionPreamble(null)).toBeNull();
    expect(validateSessionPreamble("")).toBeNull();
    expect(validateSessionPreamble("   ")).toBeNull();
    expect(validateSessionPreamble("\n\n")).toBeNull();
  });

  it("trims and returns valid one-liners", () => {
    expect(validateSessionPreamble("  Please approve the deploy.  ")).toBe(
      "Please approve the deploy.",
    );
  });

  it("permits a single newline for a two-line message", () => {
    expect(validateSessionPreamble("Heads up:\nfailing test on main")).toBe(
      "Heads up:\nfailing test on main",
    );
  });

  it("normalises CRLF and bare CR to LF before validation", () => {
    expect(validateSessionPreamble("line1\r\nline2")).toBe("line1\nline2");
    expect(validateSessionPreamble("line1\rline2")).toBe("line1\nline2");
  });

  it("rejects non-string input with a 400", () => {
    for (const v of [42, true, [], {}]) {
      try {
        validateSessionPreamble(v);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as { status?: number }).status).toBe(400);
      }
    }
  });

  it("rejects preambles longer than 280 chars (post-trim)", () => {
    try {
      validateSessionPreamble("a".repeat(281));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
    }
    expect(validateSessionPreamble("a".repeat(280))).toBe("a".repeat(280));
  });

  it("rejects tab and other control chars (but not \\n)", () => {
    for (const v of ["tab\there", "nul\x00byte", "bell\x07"]) {
      try {
        validateSessionPreamble(v);
        expect.unreachable("should have thrown for: " + JSON.stringify(v));
      } catch (err) {
        expect((err as { status?: number }).status).toBe(400);
      }
    }
  });
});
