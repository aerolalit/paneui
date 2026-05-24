// Unit tests for the JSON-Schema walker that drives the attachment-ref DB
// access check. The DB-touching half of ref-access.ts (assertBlobsAccessibleByAgent)
// is exercised by the e2e tests at src/http/routes/ref-access.e2e.test.ts —
// here we focus on the pure walker so a schema change can't silently
// stop discovering attachment ids inside event/input payloads.

import { describe, it, expect } from "vitest";
import { collectBlobRefs } from "./ref-access.js";

describe("collectBlobRefs", () => {
  it("returns [] for empty schema and empty payload", () => {
    expect(collectBlobRefs({}, {})).toEqual([]);
  });

  it("returns [] for an empty schema regardless of payload", () => {
    // Defensive: even if the payload happens to contain a string that
    // looks like a attachment_id, no schema site = no collection.
    expect(
      collectBlobRefs({}, { attachment_id: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual([]);
  });

  it("returns [] when the attachment_id site is missing from the payload", () => {
    const schema = {
      type: "object",
      properties: {
        attachment_id: { type: "string", format: "pane-attachment-id" },
      },
    };
    expect(collectBlobRefs(schema, {})).toEqual([]);
  });

  it("collects a top-level attachment_id field", () => {
    const schema = {
      type: "object",
      properties: {
        attachment_id: { type: "string", format: "pane-attachment-id" },
      },
    };
    expect(
      collectBlobRefs(schema, { attachment_id: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });

  it("collects from a nested object", () => {
    const schema = {
      type: "object",
      properties: {
        attachment: {
          type: "object",
          properties: {
            attachment_id: { type: "string", format: "pane-attachment-id" },
            mime: { type: "string" },
          },
        },
      },
    };
    expect(
      collectBlobRefs(schema, {
        attachment: {
          attachment_id: "cmpel3zb30000k923tf77pjrw",
          mime: "image/png",
        },
      }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });

  it("collects multiple attachment_ids from sibling fields", () => {
    const schema = {
      type: "object",
      properties: {
        primary: { type: "string", format: "pane-attachment-id" },
        secondary: { type: "string", format: "pane-attachment-id" },
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

  it("dedupes the same attachment_id when it appears at two sites", () => {
    const schema = {
      type: "object",
      properties: {
        primary: { type: "string", format: "pane-attachment-id" },
        secondary: { type: "string", format: "pane-attachment-id" },
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
              attachment_id: { type: "string", format: "pane-attachment-id" },
            },
          },
        },
      },
    };
    const refs = collectBlobRefs(schema, {
      attachments: [
        { attachment_id: "cmpel3zb30000k923tf77pjrw" },
        { attachment_id: "cmqfx4ac41111l834ug88qksx" },
        { attachment_id: "cmpel3zb30000k923tf77pjrw" }, // duplicate
      ],
    });
    expect(refs.sort()).toEqual(
      ["cmpel3zb30000k923tf77pjrw", "cmqfx4ac41111l834ug88qksx"].sort(),
    );
  });

  it("collects from a tuple-form array (items as array)", () => {
    const schema = {
      type: "array",
      items: [
        { type: "string", format: "pane-attachment-id" },
        { type: "number" },
      ],
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
            attachment_id: { type: "string", format: "pane-attachment-id" },
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
      collectBlobRefs(schema, { attachment_id: "cmpel3zb30000k923tf77pjrw" }),
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
            attachment_id: { type: "string", format: "pane-attachment-id" },
          },
        },
      ],
    };
    expect(
      collectBlobRefs(schema, { attachment_id: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });

  it("collects from allOf branches", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          properties: {
            attachment_id: { type: "string", format: "pane-attachment-id" },
          },
        },
      ],
    };
    expect(
      collectBlobRefs(schema, { attachment_id: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });

  it("returns [] when the schema declares no pane-attachment-id sites", () => {
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
    // without a schema site marking them as attachment refs.
    expect(
      collectBlobRefs(schema, {
        name: "cmpel3zb30000k923tf77pjrw",
        n: 1,
        nested: { x: "cmpel3zb30000k923tf77pjrw" },
      }),
    ).toEqual([]);
  });

  it("ignores wrong-typed payload values at attachment_id sites (Ajv has already rejected them)", () => {
    const schema = {
      type: "object",
      properties: {
        attachment_id: { type: "string", format: "pane-attachment-id" },
      },
    };
    // Numbers, booleans, nulls, and arrays at a string-format site should
    // be quietly skipped — the walker is not a validator.
    expect(collectBlobRefs(schema, { attachment_id: 12345 })).toEqual([]);
    expect(collectBlobRefs(schema, { attachment_id: null })).toEqual([]);
    expect(collectBlobRefs(schema, { attachment_id: ["x"] })).toEqual([]);
  });

  it("does not crash on a $ref node (refs are skipped with a TODO)", () => {
    const schema = {
      type: "object",
      properties: {
        ref: { $ref: "#/definitions/blobRef" },
      },
      definitions: {
        blobRef: { type: "string", format: "pane-attachment-id" },
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
                    attachment_id: {
                      type: "string",
                      format: "pane-attachment-id",
                    },
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
        { items: [{ attachment_id: "cmpel3zb30000k923tf77pjrw" }] },
        {
          items: [
            { attachment_id: "cmqfx4ac41111l834ug88qksx" },
            { attachment_id: "cmpel3zb30000k923tf77pjrw" }, // dup
          ],
        },
      ],
    });
    expect(refs.sort()).toEqual(
      ["cmpel3zb30000k923tf77pjrw", "cmqfx4ac41111l834ug88qksx"].sort(),
    );
  });
});

describe("collectBlobRefs — patternProperties / additionalProperties (#200)", () => {
  // Before the fix, both forms were declared on the JsonSchema type but
  // the walker never traversed them. A schema using `patternProperties`
  // or `additionalProperties` with `format: pane-attachment-id` Ajv-validated
  // fine but the walker returned [] — bypassing the cross-tenant access
  // check the module is designed to enforce.

  it("collects from patternProperties when a key matches the regex", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^attachment_": { format: "pane-attachment-id" },
      },
    };
    const refs = collectBlobRefs(schema, {
      attachment_a: "cmpel3zb30000k923tf77pjrw",
      attachment_b: "cmqfx4ac41111l834ug88qksx",
      ignored_key: "not-a-attachment-id-shape",
    });
    expect(refs.sort()).toEqual(
      ["cmpel3zb30000k923tf77pjrw", "cmqfx4ac41111l834ug88qksx"].sort(),
    );
  });

  it("collects nothing from patternProperties when no key matches", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^attachment_": { format: "pane-attachment-id" },
      },
    };
    expect(
      collectBlobRefs(schema, { other_key: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual([]);
  });

  it("collects from multiple patternProperties patterns", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^image_": { format: "pane-attachment-id" },
        "^audio_": { format: "pane-attachment-id" },
      },
    };
    const refs = collectBlobRefs(schema, {
      image_1: "cmpel3zb30000k923tf77pjrw",
      audio_1: "cmqfx4ac41111l834ug88qksx",
      video_1: "cmrev0xz52222m945hh99rmty",
    });
    expect(refs.sort()).toEqual(
      ["cmpel3zb30000k923tf77pjrw", "cmqfx4ac41111l834ug88qksx"].sort(),
    );
  });

  it("collects from additionalProperties (the catch-all branch)", () => {
    const schema = {
      type: "object",
      additionalProperties: { format: "pane-attachment-id" },
    };
    const refs = collectBlobRefs(schema, {
      anything: "cmpel3zb30000k923tf77pjrw",
      else: "cmqfx4ac41111l834ug88qksx",
    });
    expect(refs.sort()).toEqual(
      ["cmpel3zb30000k923tf77pjrw", "cmqfx4ac41111l834ug88qksx"].sort(),
    );
  });

  it("additionalProperties: false (boolean) is a no-op", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
    };
    // Even though the payload has a string at a dynamic key, the boolean
    // shape carries no sub-schema, so nothing is collected.
    expect(
      collectBlobRefs(schema, { foo: "cmpel3zb30000k923tf77pjrw" }),
    ).toEqual([]);
  });

  it("combined: properties + patternProperties + additionalProperties — each branch contributes only its share", () => {
    // Spec-compliant interaction:
    //   - keys named in `properties` are walked via `properties`
    //   - keys matching a `patternProperties` regex are walked via that regex
    //   - everything else is walked via `additionalProperties`
    // Each key is walked exactly once; no double-counting.
    const schema = {
      type: "object",
      properties: {
        cover: { format: "pane-attachment-id" },
      },
      patternProperties: {
        "^audio_": { format: "pane-attachment-id" },
      },
      additionalProperties: { format: "pane-attachment-id" },
    };
    const refs = collectBlobRefs(schema, {
      cover: "cmpel3zb30000k923tf77pjrw", // via properties
      audio_intro: "cmqfx4ac41111l834ug88qksx", // via patternProperties
      misc: "cmrev0xz52222m945hh99rmty", // via additionalProperties
    });
    // toHaveLength is the explicit guard against the walker double-counting
    // a key that matches both `properties` and a `patternProperties` regex:
    // the second walk would re-add the same attachment_id to `out` and the Set
    // dedup would silently mask it. Asserting length=3 catches a future
    // regression where dedup is removed or weakened.
    expect(refs).toHaveLength(3);
    expect(refs.sort()).toEqual(
      [
        "cmpel3zb30000k923tf77pjrw",
        "cmqfx4ac41111l834ug88qksx",
        "cmrev0xz52222m945hh99rmty",
      ].sort(),
    );
  });

  it("nested: patternProperties holding an object that itself declares format", () => {
    // Catches a regression where the walker recurses INTO the pattern's
    // sub-schema (so attachment_ids nested under a dynamic-key object are
    // still collected, not just direct-value attachment ids).
    const schema = {
      type: "object",
      patternProperties: {
        "^item_": {
          type: "object",
          properties: {
            attachment_id: { format: "pane-attachment-id" },
          },
        },
      },
    };
    const refs = collectBlobRefs(schema, {
      item_1: { attachment_id: "cmpel3zb30000k923tf77pjrw" },
      item_2: { attachment_id: "cmqfx4ac41111l834ug88qksx" },
    });
    expect(refs.sort()).toEqual(
      ["cmpel3zb30000k923tf77pjrw", "cmqfx4ac41111l834ug88qksx"].sort(),
    );
  });

  it("malformed regex in patternProperties is skipped, doesn't throw", () => {
    // Defensive: Ajv would catch this at schema-compile time, but the
    // walker shouldn't crash if it ever sees one.
    const schema = {
      type: "object",
      patternProperties: {
        "[invalid(": { format: "pane-attachment-id" }, // unbalanced bracket
      },
      properties: {
        cover: { format: "pane-attachment-id" },
      },
    };
    // `cover` still gets collected via the properties branch.
    expect(
      collectBlobRefs(schema, {
        cover: "cmpel3zb30000k923tf77pjrw",
      }),
    ).toEqual(["cmpel3zb30000k923tf77pjrw"]);
  });
});
