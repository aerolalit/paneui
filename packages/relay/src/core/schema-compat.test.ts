// Unit tests for the schema-compatibility gate (#267 PR A).
//
// The gate's job is to answer "is the new schema a superset of the old?"
// Every test below is structured as a worked example of one rule. The
// shared expectation is:
//
//   compareEventSchema(old, new)  === []   ↔   compatible
//   compareEventSchema(old, new).length > 0 ↔ list of breaks the operator sees

import { describe, it, expect } from "vitest";
import {
  compareEventSchema,
  compareInputSchema,
  compareRecordSchema,
  compareSurfaceSchemas,
  type RecordSchema,
} from "./schema-compat.js";
import type { EventSchema } from "../types.js";

// Tiny helper for building EventSchema fixtures inline without a wall of
// brackets per test.
function ev(
  events: Record<
    string,
    {
      emittedBy: ("page" | "agent")[];
      payload: object;
    }
  >,
): EventSchema {
  return { events };
}

describe("compareEventSchema — event-vocabulary diffs", () => {
  it("compatible: adding a new event type", async () => {
    const old = ev({
      "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
    });
    const next = ev({
      "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      "feed.unlogged": { emittedBy: ["page"], payload: { type: "object" } },
    });
    expect(compareEventSchema(old, next)).toEqual([]);
  });

  it("break: removing an event type", () => {
    const old = ev({
      "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      "feed.unlogged": { emittedBy: ["page"], payload: { type: "object" } },
    });
    const next = ev({
      "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.path).toBe("events.feed.unlogged");
    expect(breaks[0]!.message).toMatch(/removed/);
  });

  it("compatible: adding an emittedBy actor", () => {
    const old = ev({ x: { emittedBy: ["page"], payload: { type: "object" } } });
    const next = ev({
      x: { emittedBy: ["page", "agent"], payload: { type: "object" } },
    });
    expect(compareEventSchema(old, next)).toEqual([]);
  });

  it("break: removing an emittedBy actor", () => {
    const old = ev({
      x: { emittedBy: ["page", "agent"], payload: { type: "object" } },
    });
    const next = ev({
      x: { emittedBy: ["page"], payload: { type: "object" } },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.path).toBe("events.x.emittedBy");
    expect(breaks[0]!.message).toMatch(/agent/);
  });
});

describe("compareEventSchema — payload diffs (object types)", () => {
  it("compatible: adding an optional property", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["a"],
        },
      },
    });
    expect(compareEventSchema(old, next)).toEqual([]);
  });

  it("break: adding a required field", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.message).toMatch(/b.*required/);
  });

  it("compatible: removing a field from required (relaxation)", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a", "b"],
        },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a"],
        },
      },
    });
    expect(compareEventSchema(old, next)).toEqual([]);
  });

  it("break: narrowing a property's type", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: { a: { type: ["string", "null"] } },
        },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: { a: { type: "string" } },
        },
      },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.path).toBe("events.x.payload.properties.a.type");
    expect(breaks[0]!.message).toMatch(/null/);
  });

  it("break: additionalProperties true → false", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "object", additionalProperties: true },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "object", additionalProperties: false },
      },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.path).toBe("events.x.payload.additionalProperties");
  });
});

describe("compareEventSchema — enum / const", () => {
  it("compatible: widening an enum", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "string", enum: ["a", "b"] },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "string", enum: ["a", "b", "c"] },
      },
    });
    expect(compareEventSchema(old, next)).toEqual([]);
  });

  it("break: narrowing an enum", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "string", enum: ["a", "b", "c"] },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "string", enum: ["a", "b"] },
      },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.message).toMatch(/"c"/);
  });

  it("compatible: removing the enum constraint entirely", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "string", enum: ["a", "b"] },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "string" },
      },
    });
    expect(compareEventSchema(old, next)).toEqual([]);
  });

  it("break: adding a const that wasn't there", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "string" },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "string", const: "hello" },
      },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.path).toBe("events.x.payload.const");
  });
});

describe("compareEventSchema — numeric / string / array bounds", () => {
  it("compatible: relaxing numeric bounds", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "number", minimum: 0, maximum: 10 },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: { type: "number", minimum: -5, maximum: 100 },
      },
    });
    expect(compareEventSchema(old, next)).toEqual([]);
  });

  it("break: tightening minimum upward", () => {
    const old = ev({
      x: { emittedBy: ["page"], payload: { type: "number", minimum: 0 } },
    });
    const next = ev({
      x: { emittedBy: ["page"], payload: { type: "number", minimum: 1 } },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.message).toMatch(/minimum/);
  });

  it("break: tightening maximum downward", () => {
    const old = ev({
      x: { emittedBy: ["page"], payload: { type: "number", maximum: 100 } },
    });
    const next = ev({
      x: { emittedBy: ["page"], payload: { type: "number", maximum: 50 } },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.message).toMatch(/maximum/);
  });

  it("break: minLength tightening upward", () => {
    const old = ev({
      x: { emittedBy: ["page"], payload: { type: "string", minLength: 1 } },
    });
    const next = ev({
      x: { emittedBy: ["page"], payload: { type: "string", minLength: 5 } },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
  });

  it("compatible: maxLength relaxing upward", () => {
    const old = ev({
      x: { emittedBy: ["page"], payload: { type: "string", maxLength: 10 } },
    });
    const next = ev({
      x: { emittedBy: ["page"], payload: { type: "string", maxLength: 100 } },
    });
    expect(compareEventSchema(old, next)).toEqual([]);
  });
});

describe("compareEventSchema — recursive nesting", () => {
  it("propagates breaks through array.items.properties", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
              },
            },
          },
        },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  weight: { type: "number" },
                },
                required: ["label", "weight"],
              },
            },
          },
        },
      },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.path).toBe(
      "events.x.payload.properties.items.items.required",
    );
  });
});

describe("compareEventSchema — unverifiable schemas (anyOf / $ref / etc)", () => {
  it("emits a 'cannot verify' break for anyOf on either side", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });
    const next = ev({
      x: { emittedBy: ["page"], payload: { type: "string" } },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.message).toMatch(/anyOf/);
  });

  it("emits the break for $ref too", () => {
    const old = ev({
      x: {
        emittedBy: ["page"],
        payload: { $ref: "#/$defs/foo" },
      },
    });
    const next = ev({
      x: {
        emittedBy: ["page"],
        payload: { $ref: "#/$defs/foo" },
      },
    });
    const breaks = compareEventSchema(old, next);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.message).toMatch(/\$ref/);
  });
});

describe("compareInputSchema", () => {
  it("compatible: both null", () => {
    expect(compareInputSchema(null, null)).toEqual([]);
  });

  it("compatible: removing the schema (loosening)", () => {
    expect(compareInputSchema({ type: "object" }, null)).toEqual([]);
  });

  it("break: adding a schema where none existed (tightening)", () => {
    const breaks = compareInputSchema(null, { type: "object" });
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.path).toBe("input_schema");
  });

  it("recurses into the root schema like a payload", () => {
    const breaks = compareInputSchema(
      { type: "object", properties: { name: { type: "string" } } },
      {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    );
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks[0]!.message).toMatch(/name.*required/);
  });
});

describe("compareRecordSchema — record-collection diffs (#290)", () => {
  // Fixture builder: wrap one collection name + its row schema (the value
  // under $defs/Row_<name>) into the full recordSchema doc shape.
  function rec(
    collections: Record<
      string,
      {
        rowSchema: object;
        write?: string[];
        delete?: string[];
      }
    >,
  ): RecordSchema {
    const defs: Record<string, object> = {};
    const xpc: Record<string, object> = {};
    for (const [name, entry] of Object.entries(collections)) {
      const defName = `Row_${name}`;
      defs[defName] = entry.rowSchema;
      xpc[name] = {
        schema: { $ref: `#/$defs/${defName}` },
        write: entry.write ?? ["page"],
        delete: entry.delete ?? ["author"],
      };
    }
    return { $defs: defs, "x-pane-collections": xpc };
  }

  it("compatible: both null", () => {
    expect(compareRecordSchema(null, null)).toEqual([]);
  });

  it("compatible: null → set (additive — no records existed)", () => {
    const next = rec({
      comments: { rowSchema: { type: "object" } },
    });
    expect(compareRecordSchema(null, next)).toEqual([]);
  });

  it("break: set → null (every declared collection orphaned, one break per)", () => {
    const old = rec({
      comments: { rowSchema: { type: "object" } },
      posts: { rowSchema: { type: "object" } },
    });
    const breaks = compareRecordSchema(old, null);
    expect(breaks.length).toBe(2);
    expect(breaks.map((b) => b.path).sort()).toEqual([
      "record_schema['x-pane-collections'].comments",
      "record_schema['x-pane-collections'].posts",
    ]);
    for (const b of breaks) {
      expect(b.message).toMatch(/orphaned/);
    }
  });

  it("compatible: added collection (no rows existed on this surface)", () => {
    const old = rec({ comments: { rowSchema: { type: "object" } } });
    const next = rec({
      comments: { rowSchema: { type: "object" } },
      reactions: { rowSchema: { type: "object" } },
    });
    expect(compareRecordSchema(old, next)).toEqual([]);
  });

  it("break: removed collection", () => {
    const old = rec({
      comments: { rowSchema: { type: "object" } },
      reactions: { rowSchema: { type: "object" } },
    });
    const next = rec({ comments: { rowSchema: { type: "object" } } });
    const breaks = compareRecordSchema(old, next);
    expect(breaks.length).toBe(1);
    expect(breaks[0]!.path).toBe(
      "record_schema['x-pane-collections'].reactions",
    );
    expect(breaks[0]!.message).toMatch(/orphaned/);
  });

  it("break: renamed collection surfaces as remove+add (only the removed side is a break)", () => {
    const old = rec({ comments: { rowSchema: { type: "object" } } });
    const next = rec({ remarks: { rowSchema: { type: "object" } } });
    const breaks = compareRecordSchema(old, next);
    expect(breaks.length).toBe(1);
    expect(breaks[0]!.path).toBe(
      "record_schema['x-pane-collections'].comments",
    );
  });

  it("compatible: write principals added — authz widening doesn't affect stored data", () => {
    const old = rec({
      comments: { rowSchema: { type: "object" }, write: ["page"] },
    });
    const next = rec({
      comments: { rowSchema: { type: "object" }, write: ["page", "agent"] },
    });
    expect(compareRecordSchema(old, next)).toEqual([]);
  });

  it("compatible: write principals removed — authz tightening doesn't affect stored data", () => {
    const old = rec({
      comments: { rowSchema: { type: "object" }, write: ["page", "agent"] },
    });
    const next = rec({
      comments: { rowSchema: { type: "object" }, write: ["page"] },
    });
    expect(compareRecordSchema(old, next)).toEqual([]);
  });

  it("compatible: delete principals changed in either direction", () => {
    const old = rec({
      comments: { rowSchema: { type: "object" }, delete: ["author"] },
    });
    const widen = rec({
      comments: {
        rowSchema: { type: "object" },
        delete: ["author", "agent"],
      },
    });
    const narrow = rec({
      comments: { rowSchema: { type: "object" }, delete: ["agent"] },
    });
    expect(compareRecordSchema(old, widen)).toEqual([]);
    expect(compareRecordSchema(old, narrow)).toEqual([]);
  });

  it("compatible: row-schema widening (added optional field)", () => {
    const old = rec({
      comments: {
        rowSchema: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
        },
      },
    });
    const next = rec({
      comments: {
        rowSchema: {
          type: "object",
          properties: {
            body: { type: "string" },
            edited: { type: "boolean" },
          },
          required: ["body"],
        },
      },
    });
    expect(compareRecordSchema(old, next)).toEqual([]);
  });

  it("break: row-schema narrowing (added required field)", () => {
    const old = rec({
      comments: {
        rowSchema: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
        },
      },
    });
    const next = rec({
      comments: {
        rowSchema: {
          type: "object",
          properties: {
            body: { type: "string" },
            authorEmail: { type: "string" },
          },
          required: ["body", "authorEmail"],
        },
      },
    });
    const breaks = compareRecordSchema(old, next);
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks[0]!.path).toBe(
      "record_schema['x-pane-collections'].comments.schema.required",
    );
    expect(breaks[0]!.message).toMatch(/authorEmail.*required/);
  });

  it("break: row-schema type change", () => {
    const old = rec({
      comments: {
        rowSchema: {
          type: "object",
          properties: { rating: { type: "string" } },
        },
      },
    });
    const next = rec({
      comments: {
        rowSchema: {
          type: "object",
          properties: { rating: { type: "number" } },
        },
      },
    });
    const breaks = compareRecordSchema(old, next);
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks[0]!.message).toMatch(/string/);
  });

  it("defensive: unresolvable $ref on old or new is reported (malformed schema reached the gate)", () => {
    const valid = rec({ comments: { rowSchema: { type: "object" } } });
    const malformed: RecordSchema = {
      $defs: {},
      "x-pane-collections": {
        comments: {
          schema: { $ref: "#/$defs/Missing" },
          write: ["page"],
          delete: ["author"],
        },
      },
    };
    const breaksOld = compareRecordSchema(malformed, valid);
    expect(breaksOld[0]!.message).toMatch(/old side.*malformed/);
    const breaksNew = compareRecordSchema(valid, malformed);
    expect(breaksNew[0]!.message).toMatch(/new side.*malformed/);
  });
});

describe("compareSurfaceSchemas — combined gate", () => {
  it("returns all breaks from both halves merged", () => {
    const breaks = compareSurfaceSchemas({
      oldEventSchema: ev({
        x: {
          emittedBy: ["page"],
          payload: { type: "object" },
        },
      }),
      newEventSchema: ev({}), // removed
      oldInputSchema: null,
      newInputSchema: { type: "object" }, // added (tightening)
    });
    // 1 break from removed event + 1 break from input_schema added.
    expect(breaks.map((b) => b.path).sort()).toEqual(
      ["events.x", "input_schema"].sort(),
    );
  });

  it("empty breaks = compatible", () => {
    const breaks = compareSurfaceSchemas({
      oldEventSchema: ev({}),
      newEventSchema: ev({}),
      oldInputSchema: null,
      newInputSchema: null,
    });
    expect(breaks).toEqual([]);
  });

  it("merges record-schema breaks alongside event + input ones (#290)", () => {
    const oldRec: RecordSchema = {
      $defs: { Row: { type: "object" } },
      "x-pane-collections": {
        comments: {
          schema: { $ref: "#/$defs/Row" },
          write: ["page"],
          delete: ["author"],
        },
      },
    };
    const breaks = compareSurfaceSchemas({
      oldEventSchema: ev({}),
      newEventSchema: ev({}),
      oldInputSchema: null,
      newInputSchema: null,
      oldRecordSchema: oldRec,
      newRecordSchema: null, // every declared collection orphaned
    });
    expect(breaks.length).toBe(1);
    expect(breaks[0]!.path).toBe(
      "record_schema['x-pane-collections'].comments",
    );
  });

  it("omitting the new record-schema args preserves pre-#290 caller behavior", () => {
    // Existing callers (not yet updated) pass only the four old args.
    const breaks = compareSurfaceSchemas({
      oldEventSchema: ev({}),
      newEventSchema: ev({}),
      oldInputSchema: null,
      newInputSchema: null,
    });
    expect(breaks).toEqual([]);
  });
});
