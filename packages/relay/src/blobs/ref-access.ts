// Blob-reference access check (follow-up B of #156).
//
// Ajv's `format: pane-blob-id` (registered in core/validation.ts at Phase D
// of #156) is purely SYNTACTIC: it verifies blob_id fields are cuid-shaped
// strings. It deliberately does NOT verify the referenced blob actually
// exists, belongs to the calling agent, or hasn't been deleted — Ajv
// formats run sync + DB-free, and per-event DB lookups inside a format
// validator would be pathological.
//
// This module is the route-layer counterpart: AFTER Ajv shape validation
// passes but BEFORE the row hits Prisma, we walk the schema + payload in
// lockstep, collect every blob_id value at a `format: pane-blob-id` site,
// and batch-check the calling agent can actually access each one. A 422
// `blob_ref_not_accessible` fires when any ref dangles.
//
// What this defends against
//   * Enumeration — an attacker can't blast random blob_id values into
//     event data hoping one lands inside another agent's blob.
//   * Dangling references — a soft-deleted blob can't be re-attached by
//     baking its id into a page-emitted event.
//   * Cross-tenant leak — agent X's events can never carry agent Y's
//     blob ids (the owner check is the gate).
//
// What this DOESN'T do (known limitation)
//   * It does NOT enforce SCOPE compatibility. A session-scope blob
//     created for session A is currently accepted in an event on
//     session B as long as the calling agent owns the blob. Tightening
//     this to "session-scope blob must match THIS session" is a
//     follow-up tracked separately — the owner check is the
//     load-bearing one for the multi-tenant story.

import type { PrismaClient } from "@prisma/client";
import { errors } from "../http/errors.js";

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

// A JSON Schema-like object — we only look at a handful of keywords
// (`format`, `properties`, `items`, `oneOf`/`anyOf`/`allOf`, `$ref`) so we
// keep the type lax rather than pulling in a full JSON Schema typing.
type JsonSchema = {
  format?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  patternProperties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema | JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  // anything else — ignored by the walker.
  [key: string]: unknown;
};

/**
 * Walk `schema` (JSON Schema) and `payload` in lockstep, collecting every
 * concrete string value that sits at a site marked `format: pane-blob-id`.
 *
 * Handles:
 *   - nested objects (recurse on `properties`)
 *   - dynamic keys (recurse on `patternProperties` regexes + on
 *     `additionalProperties` for keys not matched by either)
 *   - arrays (recurse on `items`)
 *   - `oneOf` / `anyOf` / `allOf` branches — recurse into every branch
 *     and let the dedup at return collapse repeats. Choosing the "right"
 *     branch would mean re-running validation, which Ajv has already done.
 *   - missing / optional fields (skip; not an error)
 *
 * Out of scope:
 *   - it does NOT re-validate the payload (Ajv has already run)
 *   - it does NOT follow `$ref` — current event/input schemas don't use
 *     intra-document refs. A TODO is left below for the day they do.
 *
 * Returns a deduped list of blob_id strings (insertion order preserved).
 */
export function collectBlobRefs(schema: object, payload: unknown): string[] {
  const seen = new Set<string>();
  walk(schema as JsonSchema, payload, seen);
  return Array.from(seen);
}

function walk(
  schema: JsonSchema | undefined,
  value: unknown,
  out: Set<string>,
): void {
  if (!schema || typeof schema !== "object") return;

  // TODO: support `$ref` resolution within the same document if/when an
  // event or input schema starts using it. Current schemas in the relay
  // are flat enough that this hasn't been needed; flag it here so a
  // future schema author hits the limitation up front.
  if (typeof schema.$ref === "string") return;

  // The terminal case: this site declares `format: pane-blob-id`. If the
  // payload happens to be a string at this site, collect it. (Wrong-type
  // payloads have already been rejected by Ajv — we just don't crash.)
  if (schema.format === "pane-blob-id" && typeof value === "string") {
    out.add(value);
    // Fall through: a single schema node can in principle declare both
    // `format` AND `properties` (though Ajv would only validate one),
    // so don't return — keep walking.
  }

  // oneOf / anyOf / allOf — recurse into every branch. Dedup at return
  // handles the duplicate-collection case if multiple branches mark the
  // same property as a blob ref.
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) walk(branch, value, out);
    }
  }

  // Object payload — recurse into declared properties.
  if (
    schema.properties &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (propName in obj) {
        walk(propSchema, obj[propName], out);
      }
    }
  }

  // Array payload — recurse into items.
  if (Array.isArray(value) && schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      // Tuple form: positional items[i] schema.
      for (let i = 0; i < value.length; i++) {
        const itemSchema = schema.items[i];
        if (itemSchema) walk(itemSchema, value[i], out);
      }
    } else {
      // List form: one schema for every item.
      for (const item of value) walk(schema.items, item, out);
    }
  }

  // patternProperties — iterate over each regex in the schema, match
  // against the payload's actual keys, recurse on every match. Without
  // this branch, a schema like
  //   { patternProperties: { ".*": { format: "pane-blob-id" } } }
  // would Ajv-validate fine but the walker would collect zero refs,
  // skipping the cross-tenant access check entirely (#200).
  if (
    schema.patternProperties &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    const objKeys = Object.keys(obj);
    for (const [pattern, propSchema] of Object.entries(
      schema.patternProperties,
    )) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        // Malformed pattern in the schema. Ajv would have caught this
        // at schema-compile time, so reaching here means the schema
        // bypassed validation. Skip rather than throw; the rest of the
        // walk continues.
        continue;
      }
      for (const k of objKeys) {
        if (re.test(k)) walk(propSchema, obj[k], out);
      }
    }
  }

  // additionalProperties — iterate over the payload's keys NOT matched by
  // `properties` and NOT matched by any `patternProperties` regex (per
  // JSON Schema spec). The boolean shape (`additionalProperties: true/false`)
  // carries no sub-schema so we only act when it's an object.
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    const declared = new Set(Object.keys(schema.properties ?? {}));
    const patternRes: RegExp[] = [];
    for (const p of Object.keys(schema.patternProperties ?? {})) {
      try {
        patternRes.push(new RegExp(p));
      } catch {
        /* malformed — same handling as the patternProperties branch above */
      }
    }
    const additional = schema.additionalProperties;
    for (const k of Object.keys(obj)) {
      if (declared.has(k)) continue;
      if (patternRes.some((re) => re.test(k))) continue;
      walk(additional, obj[k], out);
    }
  }
}

// ---------------------------------------------------------------------------
// DB access check
// ---------------------------------------------------------------------------

/**
 * Verify every blob_id in `blobIds` is accessible to `agentId`. A blob is
 * accessible when:
 *   - a row exists in the Blob table for the id
 *   - the row's ownerId matches `agentId`
 *   - the row is not soft-deleted (deletedAt IS NULL)
 *
 * Issues a single batched Prisma query. Throws a 422
 * `blob_ref_not_accessible` ApiError listing the inaccessible ids when
 * any ref fails. No-op when `blobIds` is empty.
 *
 * "Accessible" deliberately collapses three failure modes (wrong id /
 * wrong owner / deleted) into one — an attacker probing blob_ids must
 * not be able to distinguish "this id exists but isn't mine" from "this
 * id doesn't exist at all."
 */
export async function assertBlobsAccessibleByAgent(
  prisma: PrismaClient,
  agentId: string,
  blobIds: string[],
): Promise<void> {
  if (blobIds.length === 0) return;

  // Dedup defensively — the walker already dedups, but a defensive callers
  // shouldn't rely on that contract here.
  const unique = Array.from(new Set(blobIds));

  const rows = await prisma.blob.findMany({
    where: {
      id: { in: unique },
      ownerId: agentId,
      deletedAt: null,
    },
    select: { id: true },
  });
  const accessible = new Set(rows.map((r) => r.id));
  const inaccessible = unique.filter((id) => !accessible.has(id));
  if (inaccessible.length > 0) {
    throw errors.blobRefNotAccessible(inaccessible);
  }
}
