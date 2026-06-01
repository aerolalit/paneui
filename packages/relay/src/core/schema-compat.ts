// Schema-compatibility gate for template-version upgrades (#267 PR A).
//
// Given two schemas — the pane's currently-pinned (old) and the proposed
// upgrade target (new) — decide whether `new` is a SUPERSET of `old`. The
// upgrade route (POST /v1/panes/:id/upgrade, landing in PR B) takes the
// breaks[] this returns and either:
//   - returns 422 with the list (when compat="strict", the default)
//   - logs + proceeds anyway (when compat="force", the escape hatch)
//
// The intent (per #267): every payload an old pane produced under the
// OLD schema must STILL validate under the NEW schema. So a downstream
// polymorphic-render (#268's stamped template_version) can hand old events
// to the new template's JS unchanged. "Compatible" = "anything old accepted,
// new still accepts."
//
// What we check explicitly is by design narrower than full JSON-Schema
// equivalence — every rule below is one that mattered for a real template
// iteration in the wild. If a schema uses anyOf/oneOf/allOf/not/$ref we
// can't safely reason about it without writing a JSON-Schema satisfiability
// checker; we emit a "cannot verify" break and the caller decides (review
// the schema, simplify it, or pass compat="force").
//
// Hand-rolled deliberately: gives full control over which rules count as
// breaking, custom error messages that name the exact offending change,
// and no extra runtime dep. ~250 LOC end to end. See the test file for
// the rules in worked-example form.

import type { EventSchema, EmittedBy } from "../types.js";

/** A single backwards-incompatible change between two schemas. */
export interface SchemaBreak {
  /** JSON Pointer-style path into the schema where the break lives. */
  path: string;
  /** Operator-readable description of the change. */
  message: string;
}

/** Plain JSON Schema (we accept any object; the gate doesn't enforce shape). */
type JsonSchemaLike = Record<string, unknown>;

/**
 * Compare two EventSchemas — diff the `events` map, then recursively diff
 * each event type's payload + emittedBy.
 *
 * Both null = no schema either side = no breaks.
 * Old has schema, new is null/empty = every event type was removed = lots
 * of breaks (we emit one per removed type so the operator sees scope).
 */
export function compareEventSchema(
  oldSchema: EventSchema | null,
  newSchema: EventSchema | null,
): SchemaBreak[] {
  const breaks: SchemaBreak[] = [];
  const oldEvents = oldSchema?.events ?? {};
  const newEvents = newSchema?.events ?? {};

  for (const [type, oldEntry] of Object.entries(oldEvents)) {
    const newEntry = newEvents[type];
    if (!newEntry) {
      breaks.push({
        path: `events.${type}`,
        message: `event type "${type}" was removed — panes with persisted ${type} events would lose their schema reference`,
      });
      continue;
    }
    // emittedBy: new must include every actor old allowed. Adding new
    // actors is fine; removing one is a tightening (a "page" event you
    // accepted before would now be rejected).
    const oldActors = new Set<EmittedBy>(oldEntry.emittedBy);
    const newActors = new Set<EmittedBy>(newEntry.emittedBy);
    for (const actor of oldActors) {
      if (!newActors.has(actor)) {
        breaks.push({
          path: `events.${type}.emittedBy`,
          message: `actor "${actor}" was removed from emittedBy — past events authored by ${actor} would be rejected by the new schema`,
        });
      }
    }
    // Payload: recurse. EventSchemaEntry.payload is typed `object`, so
    // asObject() never returns null in practice — but guard explicitly so
    // a future loosening of the type doesn't silently swallow nulls.
    const oldPayload = asObject(oldEntry.payload);
    const newPayload = asObject(newEntry.payload);
    if (oldPayload && newPayload) {
      breaks.push(
        ...compareJsonSchema(oldPayload, newPayload, `events.${type}.payload`),
      );
    }
  }

  // Event types added in new but not old → allowed; no breaks.

  return breaks;
}

/**
 * Compare two input schemas — the schema for pane.input_data. The whole
 * blob is a single JSON Schema (no event-vocabulary wrapper), so we just
 * recurse from the root.
 *
 * Both null = no contract either side = no breaks.
 * Old has schema, new is null = "we no longer validate input_data" — that
 * isn't technically a narrowing (every value old accepted, new accepts
 * too, since new accepts everything), so no break.
 * Old is null, new has schema = NEW restriction — but on input_data that
 * was already persisted under old (no schema), the unrestricted blob may
 * no longer validate. Treat as a break.
 */
export function compareInputSchema(
  oldSchema: JsonSchemaLike | null,
  newSchema: JsonSchemaLike | null,
): SchemaBreak[] {
  if (!oldSchema && !newSchema) return [];
  if (!oldSchema && newSchema) {
    return [
      {
        path: "input_schema",
        message:
          "input_schema was added — persisted input_data from before the upgrade was not validated and may not satisfy the new schema",
      },
    ];
  }
  if (oldSchema && !newSchema) {
    // Loosening: removing the schema means new accepts everything old
    // did + more. Not a break.
    return [];
  }
  return compareJsonSchema(oldSchema!, newSchema!, "input_schema");
}

/**
 * The recordSchema declaration shape (#287 / #289) — a plain JSON Schema
 * 2020-12 document with one namespaced extension, `x-pane-collections`,
 * that declares the template's record collections.
 */
export type RecordSchema = JsonSchemaLike;

/**
 * Compare two recordSchemas — diff the `x-pane-collections` map, then
 * recursively diff each common collection's resolved row schema.
 *
 * Both null = no record schema either side = no breaks.
 * Old has schema, new is null = every declared collection is orphaned —
 * persisted PaneRecord rows lose their schema reference. One break
 * per collection so the operator sees the scope.
 * Old is null, new has schema = additive (no panes could have
 * persisted record rows under a non-existent schema). No breaks.
 *
 * Per-collection rules (issue #290):
 *   - Added collection: fine — no rows existed for it on this pane.
 *   - Removed collection: break — existing rows would be orphaned.
 *   - Payload schema widening (added optional fields, looser bounds): fine.
 *   - Payload schema narrowing (new required field, narrower bounds, type
 *     change): break — past records would not validate under the new shape.
 *   - `write` / `delete` principals added or removed: fine — authz changes
 *     affect new operations, not stored data, so existing rows are untouched.
 *
 * Rename is intentionally NOT inferred: a removed-collection + added-collection
 * pair panes as one removed-collection break, exactly as the rule above
 * intends. The operator can pass `compat="force"` if the "rename" is meant.
 */
export function compareRecordSchema(
  oldDoc: RecordSchema | null,
  newDoc: RecordSchema | null,
): SchemaBreak[] {
  const breaks: SchemaBreak[] = [];
  if (!oldDoc && !newDoc) return breaks;
  if (!oldDoc) {
    // null → set: additive. The new collections start empty for the pane.
    return breaks;
  }
  if (!newDoc) {
    // set → null: every declared collection orphaned. Emit one break per.
    const oldCollections = collectionsOf(oldDoc);
    for (const name of Object.keys(oldCollections)) {
      breaks.push({
        path: `record_schema['x-pane-collections'].${name}`,
        message: `collection "${name}" was removed (record_schema dropped entirely) — persisted records in this collection would be orphaned`,
      });
    }
    return breaks;
  }

  const oldCollections = collectionsOf(oldDoc);
  const newCollections = collectionsOf(newDoc);

  for (const [name, oldEntry] of Object.entries(oldCollections)) {
    const newEntry = newCollections[name];
    if (!newEntry) {
      breaks.push({
        path: `record_schema['x-pane-collections'].${name}`,
        message: `collection "${name}" was removed — persisted records in this collection would be orphaned`,
      });
      continue;
    }
    // write / delete principal changes are intentionally NOT breaks — authz
    // changes affect future operations, not stored data. See the JSDoc above.

    const oldRow = resolveRowSchema(oldDoc, oldEntry);
    const newRow = resolveRowSchema(newDoc, newEntry);
    if (oldRow === null || newRow === null) {
      // Defensive: a malformed schema slipped past validation. The shape
      // validator (#289 — validateRecordSchemaShape) already rejects this
      // at write-time, but flag it so a force-through doesn't silently
      // pass through a malformed schema.
      breaks.push({
        path: `record_schema['x-pane-collections'].${name}.schema`,
        message: `row schema for "${name}" could not be resolved on the ${oldRow === null ? "old" : "new"} side — record_schema is malformed (schema.$ref must resolve to an object under $defs)`,
      });
      continue;
    }
    breaks.push(
      ...compareJsonSchema(
        oldRow,
        newRow,
        `record_schema['x-pane-collections'].${name}.schema`,
      ),
    );
  }

  // Added collections: fine. No pane had rows for them yet, so the new
  // declaration introduces no incompat against stored data.
  return breaks;
}

/**
 * Combined gate for the upgrade route — diff every schema kind in one call
 * and return the merged breaks list. The record-schema args are optional so
 * existing callers (pre-#290) continue to type-check.
 */
export function comparePaneSchemas(args: {
  oldEventSchema: EventSchema | null;
  newEventSchema: EventSchema | null;
  oldInputSchema: JsonSchemaLike | null;
  newInputSchema: JsonSchemaLike | null;
  oldRecordSchema?: RecordSchema | null;
  newRecordSchema?: RecordSchema | null;
}): SchemaBreak[] {
  return [
    ...compareEventSchema(args.oldEventSchema, args.newEventSchema),
    ...compareInputSchema(args.oldInputSchema, args.newInputSchema),
    ...compareRecordSchema(
      args.oldRecordSchema ?? null,
      args.newRecordSchema ?? null,
    ),
  ];
}

// Pull the `x-pane-collections` map off a recordSchema doc, validating each
// entry is an object (skipping malformed entries — the shape validator
// (#289) catches malformed shapes at write time; the compat gate is
// defensive).
function collectionsOf(doc: RecordSchema): Record<string, JsonSchemaLike> {
  const x = doc["x-pane-collections"];
  if (!x || typeof x !== "object" || Array.isArray(x)) return {};
  const out: Record<string, JsonSchemaLike> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    const obj = asObject(v);
    if (obj) out[k] = obj;
  }
  return out;
}

// Resolve a collection entry's `schema.$ref` (of the form `#/$defs/<Name>`)
// against the doc's own `$defs`. Returns null if the schema/ref is missing,
// the ref isn't a local `#/$defs/<Name>` pointer, or the target doesn't exist.
function resolveRowSchema(
  doc: RecordSchema,
  collectionEntry: JsonSchemaLike,
): JsonSchemaLike | null {
  const schemaField = asObject(collectionEntry["schema"]);
  if (!schemaField) return null;
  const refRaw = schemaField["$ref"];
  if (typeof refRaw !== "string") return null;
  const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(refRaw);
  if (!match) return null;
  const defs = asObject(doc["$defs"]);
  if (!defs) return null;
  const defName = match[1] as string;
  return asObject(defs[defName]);
}

// -------------------------------------------------------------------------
// Generic JSON-Schema diff. The recursive workhorse.
// -------------------------------------------------------------------------

// Combinators we can't safely reason about without a satisfiability solver.
// If EITHER side uses one of these at a level we recurse into, we emit a
// single "cannot verify" break — strict mode then refuses; force overrides.
const UNVERIFIABLE_KEYS = ["anyOf", "oneOf", "allOf", "not", "$ref"] as const;

function compareJsonSchema(
  oldS: JsonSchemaLike,
  newS: JsonSchemaLike,
  path: string,
): SchemaBreak[] {
  const breaks: SchemaBreak[] = [];

  // Unverifiable combinators short-circuit the diff. We don't return
  // immediately because there might be other concrete narrowings worth
  // reporting in the same call, but we DO emit a clear "cannot verify"
  // marker so the operator knows strict mode failed for a structural
  // reason, not a specific tightening.
  for (const key of UNVERIFIABLE_KEYS) {
    if (key in oldS || key in newS) {
      breaks.push({
        path,
        message: `schema uses "${key}" — automated compatibility verification is not supported here; review manually, simplify the schema, or pass compat="force"`,
      });
      // No point recursing into properties of an unverifiable schema.
      return breaks;
    }
  }

  // ---- type --------------------------------------------------------------
  // A type change is the bluntest break. `type: "string"` → `type: "number"`
  // means nothing old accepted is still valid. Arrays of types ([" string",
  // "null"]) are fine as long as old's set is a subset of new's.
  const oldTypes = normaliseTypes(oldS["type"]);
  const newTypes = normaliseTypes(newS["type"]);
  if (oldTypes && newTypes) {
    for (const t of oldTypes) {
      if (!newTypes.has(t)) {
        breaks.push({
          path: `${path}.type`,
          message: `type "${t}" was removed — values of that type are no longer accepted`,
        });
      }
    }
  }
  // If only new has type[], that's a NEW restriction (the field used to
  // accept anything; now it only accepts these). Tightening.
  if (!oldTypes && newTypes) {
    breaks.push({
      path: `${path}.type`,
      message: `type constraint was added (${[...newTypes].join("|")}) — values without a matching type are no longer accepted`,
    });
  }

  // ---- enum / const ------------------------------------------------------
  // New enum must include every old enum value (else narrowing). If old
  // didn't have an enum and new does → new constraint = narrowing.
  const oldEnum = asArray(oldS["enum"]);
  const newEnum = asArray(newS["enum"]);
  if (oldEnum && !newEnum) {
    // Loosening (old was enum-restricted, new isn't). Fine.
  } else if (!oldEnum && newEnum) {
    breaks.push({
      path: `${path}.enum`,
      message: `enum constraint was added — values outside [${newEnum.join(", ")}] are no longer accepted`,
    });
  } else if (oldEnum && newEnum) {
    const newSet = new Set(newEnum.map((v) => JSON.stringify(v)));
    for (const v of oldEnum) {
      if (!newSet.has(JSON.stringify(v))) {
        breaks.push({
          path: `${path}.enum`,
          message: `enum value ${JSON.stringify(v)} was removed`,
        });
      }
    }
  }

  // `const` is "enum of one." Same rules: old const → new must accept it.
  if ("const" in oldS) {
    if ("const" in newS) {
      if (JSON.stringify(oldS["const"]) !== JSON.stringify(newS["const"])) {
        breaks.push({
          path: `${path}.const`,
          message: `const changed from ${JSON.stringify(oldS["const"])} to ${JSON.stringify(newS["const"])}`,
        });
      }
    }
    // old has const, new has no const → loosening (new accepts more). Fine.
  } else if ("const" in newS) {
    breaks.push({
      path: `${path}.const`,
      message: `const constraint added (${JSON.stringify(newS["const"])}) — other values no longer accepted`,
    });
  }

  // ---- numeric bounds ----------------------------------------------------
  // For each bound, the new schema can only be looser. e.g. min can drop,
  // max can rise. Tightening either direction is a break.
  diffBound(oldS, newS, "minimum", "<=", path, breaks);
  diffBound(oldS, newS, "exclusiveMinimum", "<=", path, breaks);
  diffBound(oldS, newS, "maximum", ">=", path, breaks);
  diffBound(oldS, newS, "exclusiveMaximum", ">=", path, breaks);

  // ---- string lengths ----------------------------------------------------
  diffBound(oldS, newS, "minLength", "<=", path, breaks);
  diffBound(oldS, newS, "maxLength", ">=", path, breaks);

  // ---- array lengths -----------------------------------------------------
  diffBound(oldS, newS, "minItems", "<=", path, breaks);
  diffBound(oldS, newS, "maxItems", ">=", path, breaks);

  // ---- pattern / format --------------------------------------------------
  // Regex equivalence is undecidable in general; treat any pattern change
  // as breaking. Same for format — a new format is a new restriction.
  if (oldS["pattern"] !== newS["pattern"]) {
    if (newS["pattern"] !== undefined) {
      breaks.push({
        path: `${path}.pattern`,
        message:
          oldS["pattern"] === undefined
            ? `pattern constraint added (${String(newS["pattern"])}) — values not matching the regex are no longer accepted`
            : `pattern changed from ${String(oldS["pattern"])} to ${String(newS["pattern"])} — pattern equivalence cannot be verified`,
      });
    }
    // pattern removed → loosening, fine.
  }
  if (oldS["format"] !== newS["format"]) {
    if (newS["format"] !== undefined) {
      breaks.push({
        path: `${path}.format`,
        message:
          oldS["format"] === undefined
            ? `format constraint added ("${String(newS["format"])}") — values that don't match the format are no longer accepted`
            : `format changed from "${String(oldS["format"])}" to "${String(newS["format"])}"`,
      });
    }
  }

  // ---- required ----------------------------------------------------------
  // New required[] must be a SUBSET of old required[]. Adding a required
  // field breaks past payloads that omitted it.
  const oldRequired = new Set(asStringArray(oldS["required"]) ?? []);
  const newRequired = asStringArray(newS["required"]) ?? [];
  for (const field of newRequired) {
    if (!oldRequired.has(field)) {
      breaks.push({
        path: `${path}.required`,
        message: `field "${field}" is now required but wasn't before — past payloads that omitted it would no longer validate`,
      });
    }
  }

  // ---- properties --------------------------------------------------------
  // Each old property must still be at least as permissive in new. Removing
  // a property from `properties` is fine as long as additionalProperties
  // didn't change shape (we handle that below); explicit narrowing of a
  // present property is the common case.
  const oldProps = asObject(oldS["properties"]) ?? {};
  const newProps = asObject(newS["properties"]) ?? {};
  for (const [name, oldChild] of Object.entries(oldProps)) {
    const newChild = newProps[name];
    if (newChild === undefined) {
      // Old required this property's schema; new doesn't mention it. With
      // default additionalProperties=true, "no mention" means "anything
      // allowed" — strictly looser. No break.
      continue;
    }
    const childOld = asObject(oldChild);
    const childNew = asObject(newChild);
    if (!childOld || !childNew) continue;
    breaks.push(
      ...compareJsonSchema(childOld, childNew, `${path}.properties.${name}`),
    );
  }

  // ---- additionalProperties ----------------------------------------------
  // additionalProperties: true → false is a tightening. true → schema (an
  // object schema) is also a tightening unless schema is `true`.
  if (
    oldS["additionalProperties"] === true ||
    oldS["additionalProperties"] === undefined
  ) {
    if (newS["additionalProperties"] === false) {
      breaks.push({
        path: `${path}.additionalProperties`,
        message:
          "additionalProperties changed from true (default) to false — payloads with extra properties are no longer accepted",
      });
    }
    // additionalProperties: <schema> on new side is also tightening, but
    // analysing whether the old extras would still validate against the
    // new sub-schema is unverifiable in general. Emit a break.
    if (typeof newS["additionalProperties"] === "object") {
      breaks.push({
        path: `${path}.additionalProperties`,
        message:
          "additionalProperties was constrained to a schema — extras that were unrestricted may now be rejected",
      });
    }
  }

  // ---- items -------------------------------------------------------------
  // Array element schema: new.items must be a superset.
  const oldItems = asObject(oldS["items"]);
  const newItems = asObject(newS["items"]);
  if (oldItems && newItems) {
    breaks.push(...compareJsonSchema(oldItems, newItems, `${path}.items`));
  } else if (!oldItems && newItems) {
    // Going from "no item constraint" to "items must match X" is tightening.
    breaks.push({
      path: `${path}.items`,
      message:
        "items constraint was added — array elements that did not previously have a schema are now constrained",
    });
  }

  return breaks;
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function diffBound(
  oldS: JsonSchemaLike,
  newS: JsonSchemaLike,
  key: string,
  /** Direction the NEW value must be relative to OLD to be looser. */
  dir: "<=" | ">=",
  path: string,
  breaks: SchemaBreak[],
): void {
  const oldV = oldS[key];
  const newV = newS[key];
  if (newV === undefined) {
    // Removing a bound is loosening. Fine.
    return;
  }
  if (oldV === undefined) {
    // Adding a bound where none existed is a new restriction.
    breaks.push({
      path: `${path}.${key}`,
      message: `${key} constraint added (${String(newV)}) — values outside the bound are no longer accepted`,
    });
    return;
  }
  const o = Number(oldV);
  const n = Number(newV);
  if (!Number.isFinite(o) || !Number.isFinite(n)) return;
  const tighter = dir === "<=" ? n > o : n < o;
  if (tighter) {
    breaks.push({
      path: `${path}.${key}`,
      message: `${key} tightened from ${o} to ${n}`,
    });
  }
}

function normaliseTypes(t: unknown): Set<string> | null {
  if (t === undefined) return null;
  if (typeof t === "string") return new Set([t]);
  if (Array.isArray(t))
    return new Set(t.filter((x): x is string => typeof x === "string"));
  return null;
}

function asObject(v: unknown): JsonSchemaLike | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as JsonSchemaLike;
  }
  return null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string");
}
