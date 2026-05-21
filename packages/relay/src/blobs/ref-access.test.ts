// Unit tests for the JSON-Schema walker that drives the blob-ref DB
// access check. The DB-touching half of ref-access.ts (assertBlobsAccessibleByAgent)
// is exercised by the e2e tests at src/http/routes/ref-access.e2e.test.ts —
// here we focus on the pure walker so a schema change can't silently
// stop discovering blob ids inside event/input payloads.

import { describe, it, expect } from "vitest";
import { collectBlobRefs } from "./ref-access.js";

describe("collectBlobRefs", () => {
  it("returns [] for empty schema and empty payload", () => {
    expect(collectBlobRefs({}, {})).toEqual([]);
  });

  it("returns [] for an empty schema regardless of payload", () => {
    // Defensive: even if the payload happens to contain a string that
    // looks like a blob_id, no schema site = no collection.
    expect(
      collectBlobRefs({}, { blob_id: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual([]);
  });

  it("returns [] when the blob_id site is missing from the payload", () => {
    const schema = {
      type: "object",
      properties: {
        blob_id: { type: "string", format: "pane-blob-id" },
      },
    };
    expect(collectBlobRefs(schema, {})).toEqual([]);
  });

  it("collects a top-level blob_id field", () => {
    const schema = {
      type: "object",
      properties: {
        blob_id: { type: "string", format: "pane-blob-id" },
      },
    };
    expect(
      collectBlobRefs(schema, { blob_id: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });

  it("collects from a nested object", () => {
    const schema = {
      type: "object",
      properties: {
        blob: {
          type: "object",
          properties: {
            blob_id: { type: "string", format: "pane-blob-id" },
            mime: { type: "string" },
          },
        },
      },
    };
    expect(
      collectBlobRefs(schema, {
        blob: { blob_id: "cmpel3zb30000k923tf77pjrw", mime: "image/png" },
      }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });

  it("collects multiple blob_ids from sibling fields", () => {
    const schema = {
      type: "object",
      properties: {
        primary: { type: "string", format: "pane-blob-id" },
        secondary: { type: "string", format: "pane-blob-id" },
      },
    };
    const refs = collectBlobRefs(schema, {
      primary: "cmpel3zb30000k923tf77pjrw",
      secondary: "cmqfx4ac41111l834ug88qksx",
    });
    expect(refs.sort()).toEqual(
      ["cmpel3zb30000k923tf77pjrw", "cmqfx4ac41111l834ug88qksx"].sort(),
    );
  });

  it("dedupes the same blob_id when it appears at two sites", () => {
    const schema = {
      type: "object",
      properties: {
        primary: { type: "string", format: "pane-blob-id" },
        secondary: { type: "string", format: "pane-blob-id" },
      },
    };
    const refs = collectBlobRefs(schema, {
      primary: "cmpel3zb30000k923tf77pjrw",
      secondary: "cmpel3zb30000k923tf77pjrw",
    });
    expect(refs).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });

  it("collects from an array of objects", () => {
    const schema = {
      type: "object",
      properties: {
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              blob_id: { type: "string", format: "pane-blob-id" },
            },
          },
        },
      },
    };
    const refs = collectBlobRefs(schema, {
      attachments: [
        { blob_id: "cmpel3zb30000k923tf77pjrw" },
        { blob_id: "cmqfx4ac41111l834ug88qksx" },
        { blob_id: "cmpel3zb30000k923tf77pjrw" }, // duplicate
      ],
    });
    expect(refs.sort()).toEqual(
      ["cmpel3zb30000k923tf77pjrw", "cmqfx4ac41111l834ug88qksx"].sort(),
    );
  });

  it("collects from a tuple-form array (items as array)", () => {
    const schema = {
      type: "array",
      items: [{ type: "string", format: "pane-blob-id" }, { type: "number" }],
    };
    expect(collectBlobRefs(schema, ["cmpel3zb30000k923tf77pjrw", 42])).toEqual([
      "cmpel3zb30000k923tf77pjrw",
    ]);
  });

  it("collects from oneOf branches (every branch is walked)", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: {
            blob_id: { type: "string", format: "pane-blob-id" },
          },
        },
        {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      ],
    };
    expect(
      collectBlobRefs(schema, { blob_id: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
    // And: the text branch alone should still produce no refs.
    expect(collectBlobRefs(schema, { text: "hello" })).toEqual([]);
  });

  it("collects from anyOf branches", () => {
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            blob_id: { type: "string", format: "pane-blob-id" },
          },
        },
      ],
    };
    expect(
      collectBlobRefs(schema, { blob_id: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });

  it("collects from allOf branches", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          properties: {
            blob_id: { type: "string", format: "pane-blob-id" },
          },
        },
      ],
    };
    expect(
      collectBlobRefs(schema, { blob_id: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });

  it("returns [] when the schema declares no pane-blob-id sites", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        n: { type: "number" },
        nested: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      },
    };
    // The payload contains strings that look like cuids — irrelevant
    // without a schema site marking them as blob refs.
    expect(
      collectBlobRefs(schema, {
        name: "cmpel3zb30000k923tf77pjrw",
        n: 1,
        nested: { x: "cmpel3zb30000k923tf77pjrw" },
      }),
    ).toEqual([]);
  });

  it("ignores wrong-typed payload values at blob_id sites (Ajv has already rejected them)", () => {
    const schema = {
      type: "object",
      properties: {
        blob_id: { type: "string", format: "pane-blob-id" },
      },
    };
    // Numbers, booleans, nulls, and arrays at a string-format site should
    // be quietly skipped — the walker is not a validator.
    expect(collectBlobRefs(schema, { blob_id: 12345 })).toEqual([]);
    expect(collectBlobRefs(schema, { blob_id: null })).toEqual([]);
    expect(collectBlobRefs(schema, { blob_id: ["x"] })).toEqual([]);
  });

  it("does not crash on a $ref node (refs are skipped with a TODO)", () => {
    const schema = {
      type: "object",
      properties: {
        ref: { $ref: "#/definitions/blobRef" },
      },
      definitions: {
        blobRef: { type: "string", format: "pane-blob-id" },
      },
    };
    // The walker currently doesn't follow $ref — we just verify it
    // returns without throwing and doesn't accidentally collect.
    expect(
      collectBlobRefs(schema, { ref: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual([]);
  });

  it("handles deeply nested mixes (arrays in objects in arrays)", () => {
    const schema = {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    blob_id: { type: "string", format: "pane-blob-id" },
                  },
                },
              },
            },
          },
        },
      },
    };
    const refs = collectBlobRefs(schema, {
      groups: [
        { items: [{ blob_id: "cmpel3zb30000k923tf77pjrw" }] },
        {
          items: [
            { blob_id: "cmqfx4ac41111l834ug88qksx" },
            { blob_id: "cmpel3zb30000k923tf77pjrw" }, // dup
          ],
        },
      ],
    });
    expect(refs.sort()).toEqual(
      ["cmpel3zb30000k923tf77pjrw", "cmqfx4ac41111l834ug88qksx"].sort(),
    );
  });
});
