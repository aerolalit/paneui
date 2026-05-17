import { describe, it, expect } from "vitest";
import {
  validateEvent,
  validateSchemaShape,
  mergeSchemaAdditive,
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
