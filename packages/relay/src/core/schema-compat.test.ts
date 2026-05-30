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
  compareSurfaceSchemas,
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
});
