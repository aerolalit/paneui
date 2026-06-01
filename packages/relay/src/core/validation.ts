import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { AuthorKind, EmittedBy, EventSchema } from "../types.js";
import { errors } from "../http/errors.js";

// Ajv v8 ships as CJS; under "module": "NodeNext" the default import sometimes
// resolves to the namespace, not the constructor. createRequire bypasses that.
const require = createRequire(import.meta.url);

const AjvCtor: new (opts?: object) => {
  compile: (schema: object) => ValidateFunction;
  addFormat: (
    name: string,
    fmt:
      | { type: "string"; validate: (s: string) => boolean }
      | ((s: string) => boolean),
  ) => unknown;
} = require("ajv");

// allErrors: true reports every failing JSON Schema path, not just the first.
// Both schema_violation (event data) and input_schema_violation (pane
// input_data) callers already pass the full `validate.errors` array through
// to the error envelope's `details`, so flipping this flag is the only
// change needed for callers to receive all errors at once. Reporter (#137)
// observed only `/n must be integer` for an input that also violated /name
// — without this flag, Ajv short-circuits on first failure and callers
// have to fix-and-retry one field at a time.
const ajv = new AjvCtor({
  strict: false,
  allErrors: true,
  removeAdditional: false,
});

// Separate Ajv instance configured for JSON Schema 2020-12, used to validate
// recordSchema documents (#287 / #289). Kept distinct from the default `ajv`
// instance above so the 2020-12 vocabulary cannot leak into event- or
// input-schema validation, which target draft-07 by convention.
const Ajv2020Ctor: typeof AjvCtor = require("ajv/dist/2020");
const ajv2020 = new Ajv2020Ctor({
  strict: false,
  allErrors: true,
  removeAdditional: false,
});

// `format: pane-attachment-id` — schema vocabulary for attachment references inside
// event payloads + input_data. The format is purely SYNTACTIC: a cuid-
// shaped string. The relay's authoritative access check (does this attachment
// exist? does the calling agent own it? is the scope compatible with this
// pane?) lives in the route layer because Ajv format validators are
// expected to be sync + DB-free.
//
// Schemas that want to declare a attachment ref:
//
//   { "type": "string", "format": "pane-attachment-id" }
//
// …or, more commonly, wrapped in a tagged object so the schema can also
// carry expected mime / size constraints:
//
//   {
//     "type": "object",
//     "properties": {
//       "attachment_id": { "type": "string", "format": "pane-attachment-id" },
//       "mime": { "type": "string", "pattern": "^image/" }
//     },
//     "required": ["attachment_id"]
//   }
//
// The format check rejects empty / wrong-shape strings up front so the
// downstream batch-lookup can assume well-formed input.
ajv.addFormat("pane-attachment-id", {
  type: "string",
  validate: (s: string): boolean =>
    typeof s === "string" && /^c[a-z0-9]{20,40}$/.test(s),
});

// Mirror the same format on the 2020-12 instance so record payloads can
// declare attachment refs just like event payloads can.
ajv2020.addFormat("pane-attachment-id", {
  type: "string",
  validate: (s: string): boolean =>
    typeof s === "string" && /^c[a-z0-9]{20,40}$/.test(s),
});

// Compiled-validator cache, keyed by `${paneId}:${schemaVersion}`. Entries
// are explicitly dropped via invalidateSchemaCache — on pane DELETE and on
// TTL expiry (the sweeper collects swept pane ids and invalidates each).
// As a backstop against any path that fails to invalidate, the cache is also
// bounded so it can't leak unboundedly: it is a simple LRU — a JS Map preserves
// insertion order, so "least recently used" = the first key; on a hit we
// delete + re-set to move the entry to the most-recent position.
const CACHE_MAX = 10_000;
const cache = new Map<string, Map<string, ValidateFunction>>();
const cacheKey = (paneId: string, schemaVersion: number): string =>
  `${paneId}:${schemaVersion}`;

function getCompilers(
  paneId: string,
  schemaVersion: number,
  schema: EventSchema,
): Map<string, ValidateFunction> {
  const k = cacheKey(paneId, schemaVersion);
  const hit = cache.get(k);
  if (hit) {
    // Mark as most-recently-used.
    cache.delete(k);
    cache.set(k, hit);
    return hit;
  }
  const m = new Map<string, ValidateFunction>();
  for (const [type, entry] of Object.entries(schema.events)) {
    m.set(type, ajv.compile(entry.payload));
  }
  cache.set(k, m);
  // Evict the least-recently-used entry (the oldest insertion) once over cap.
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return m;
}

export function invalidateSchemaCache(paneId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${paneId}:`)) cache.delete(k);
  }
}

// Test-only introspection of the compiled-validator LRU. Not part of the
// public API — exported solely so the unit test can assert eviction and
// recency behaviour without compiling 10k schemas.
export const __schemaCacheInternals = {
  max: CACHE_MAX,
  size: (): number => cache.size,
  has: (paneId: string, schemaVersion: number): boolean =>
    cache.has(cacheKey(paneId, schemaVersion)),
  clear: (): void => cache.clear(),
};

export interface ValidateEventArgs {
  paneId: string;
  schemaVersion: number;
  // `null` = the pinned template version declares no event schema (a view-only
  // template). validateEvent rejects every page/agent emit against such a
  // pane; only system events flow (they bypass validateEvent entirely).
  schema: EventSchema | null;
  type: string;
  data: unknown;
  authorKind: AuthorKind;
}

// Namespaced event types: start lowercase, then alnum or dot, end alnum.
// camelCase second segments (e.g. `review.commentAdded`) are allowed.
const TYPE_RX = /^[a-z][a-zA-Z0-9.]*[a-zA-Z0-9]$/;

export function validateEvent(args: ValidateEventArgs): void {
  // A schemaless pane is view-only: it declares an empty event vocabulary,
  // strictly enforced. Every page/agent emit is rejected — there is no type it
  // could possibly match. System events never reach here (appendSystemEvent
  // writes directly), so the `!== "system"` guard is belt-and-braces.
  if (args.schema === null) {
    if (args.authorKind !== "system") {
      throw errors.schemaViolation(
        "unknown_event_type",
        { type: args.type },
        "this pane declares no event schema; it is view-only and accepts no page/agent events",
      );
    }
    // A system author against a schemaless pane: nothing to validate
    // against, and system events bypass schema rules anyway — accept it.
    return;
  }
  // Past this point the schema is non-null.
  const schema = args.schema;
  const entry = schema.events[args.type];
  if (!entry) {
    throw errors.schemaViolation(
      "unknown_event_type",
      { type: args.type },
      `event type '${args.type}' is not declared in the pane schema; emit a declared type or PATCH the schema to add it`,
    );
  }

  if (args.authorKind !== "system") {
    const required: EmittedBy = args.authorKind === "human" ? "page" : "agent";
    if (!entry.emittedBy.includes(required)) {
      throw errors.forbidden(
        "author_not_allowed",
        `${args.authorKind} cannot emit ${args.type}`,
        `author kind '${args.authorKind}' is not in emittedBy for event type '${args.type}'; only the declared actor kinds may emit it`,
      );
    }
  }

  const compilers = getCompilers(args.paneId, args.schemaVersion, schema);
  const validate = compilers.get(args.type)!;
  if (!validate(args.data)) {
    throw errors.schemaViolation(
      "schema_violation",
      validate.errors,
      `event data does not validate against the payload schema for type '${args.type}'; see details for the failing JSON Schema paths`,
    );
  }
}

// Validate an agent-supplied pane title. Trust boundary: this value is
// untrusted agent input that the bridge shell renders into <title> (HTML-
// escaped at render time). We enforce shape only — printable, single-line,
// length-bounded — and return the trimmed value. Callers feed the returned
// value through to persistence and then to renderShell, which escapes it.
//
// Rejection rules (each throws a 400 invalid_request with a specific hint):
//   - not a string
//   - empty after trim
//   - longer than 80 chars (after trim)
//   - contains an ASCII control char (\x00..\x1f, incl. \n, \r, \t)
const TITLE_MAX_LEN = 80;
// Reject ASCII control chars in agent-supplied titles before they reach
// <title>. The lint rule that flags this regex is exactly the case we're
// implementing on purpose.
// eslint-disable-next-line no-control-regex
const TITLE_CTRL_RX = /[\x00-\x1f]/;

export function validateSessionTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    throw errors.invalidRequest(
      "title must be a string",
      undefined,
      'pass `title` as a JSON string (e.g. "PR #123 review")',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw errors.invalidRequest(
      "title must be non-empty",
      undefined,
      "pass a non-blank title (it is rendered as the browser tab title)",
    );
  }
  if (trimmed.length > TITLE_MAX_LEN) {
    throw errors.invalidRequest(
      `title is too long: ${trimmed.length} chars exceeds the ${TITLE_MAX_LEN}-char limit`,
      { length: trimmed.length, max: TITLE_MAX_LEN },
      `shorten the title to ${TITLE_MAX_LEN} characters or fewer`,
    );
  }
  if (TITLE_CTRL_RX.test(trimmed)) {
    throw errors.invalidRequest(
      "title must not contain control characters (newlines, tabs, etc.)",
      undefined,
      "remove any newline, tab, or other control characters — the title is a single-line label",
    );
  }
  return trimmed;
}

// Validate an agent-supplied pane preamble. Trust boundary: untrusted
// agent input rendered (HTML-escaped) into the shell band above the iframe.
// Rules:
//   - not a string → 400
//   - empty after trim → treat as omitted (return null)
//   - longer than 280 chars after trim → 400
//   - control chars rejected EXCEPT a single `\n` (two-line message is fine);
//     normalises `\r\n` and bare `\r` to `\n` before the check
const PREAMBLE_MAX_LEN = 280;
// eslint-disable-next-line no-control-regex
const PREAMBLE_FORBIDDEN_CTRL_RX = /[\x00-\x09\x0b-\x1f]/;

export function validateSessionPreamble(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw errors.invalidRequest(
      "preamble must be a string",
      undefined,
      'pass `preamble` as a JSON string (e.g. "Your CI bot wants you to approve the deploy")',
    );
  }
  const normalised = raw.replace(/\r\n?/g, "\n").trim();
  if (normalised.length === 0) return null;
  if (normalised.length > PREAMBLE_MAX_LEN) {
    throw errors.invalidRequest(
      `preamble is too long: ${normalised.length} chars exceeds the ${PREAMBLE_MAX_LEN}-char limit`,
      { length: normalised.length, max: PREAMBLE_MAX_LEN },
      `shorten the preamble to ${PREAMBLE_MAX_LEN} characters or fewer`,
    );
  }
  if (PREAMBLE_FORBIDDEN_CTRL_RX.test(normalised)) {
    throw errors.invalidRequest(
      "preamble must not contain control characters other than newline",
      undefined,
      "remove tabs and other control characters — only a single `\\n` for a line break is allowed",
    );
  }
  return normalised;
}

// Compute the maximum nesting depth of a JSON value. Objects and arrays add one
// level; primitives are depth 0. Used to reject pathologically-nested schemas
// before Ajv compiles them. Bails out early once `limit` is exceeded so a
// deeply-nested input can't itself drive unbounded recursion.
function jsonDepth(value: unknown, limit: number): number {
  if (value === null || typeof value !== "object") return 0;
  let max = 0;
  for (const child of Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>)) {
    const d = 1 + jsonDepth(child, limit);
    if (d > max) max = d;
    if (max > limit) return max;
  }
  return max;
}

// Reject an agent-supplied schema that exceeds the configured byte size or
// nesting depth, *before* it reaches Ajv. The serialized byte size guards
// against large schemas; the depth limit guards against deeply-nested ones.
// Both throw a 400 with a message naming the limit that was exceeded.
export function assertSchemaWithinLimits(
  raw: unknown,
  limits: { maxBytes: number; maxDepth: number },
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw errors.invalidRequest(
      "schema must be JSON-serializable (no circular references)",
    );
  }
  const bytes = serialized ? Buffer.byteLength(serialized, "utf8") : 0;
  if (bytes > limits.maxBytes) {
    throw errors.invalidRequest(
      `schema is too large: ${bytes} bytes exceeds the MAX_SCHEMA_BYTES limit of ${limits.maxBytes} bytes`,
    );
  }
  const depth = jsonDepth(raw, limits.maxDepth);
  if (depth > limits.maxDepth) {
    throw errors.invalidRequest(
      `schema is too deeply nested: depth exceeds the MAX_SCHEMA_DEPTH limit of ${limits.maxDepth}`,
    );
  }
}

// #300 — top-level allowed keys for the standards-aligned event schema. Strict
// like x-pane-collections (recordSchema): unknown keys are rejected so a typo
// doesn't get silently dropped.
const STANDARDS_EVENT_SCHEMA_TOP_KEYS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$comment",
  "x-pane-events",
]);
const STANDARDS_EVENT_ENTRY_KEYS = new Set(["payload", "emit"]);
const STANDARDS_EVENT_EMIT_PRINCIPALS = new Set(["agent", "page"]);

// Validate the *shape* of an event schema at pane-create / schema-patch time.
// Accepts BOTH the legacy bespoke shape and the standards-aligned shape (#300):
//
//   Legacy (still supported, no plans to remove):
//     { events: { "type.name": { payload: {...JSON Schema}, emittedBy: [...] } } }
//
//   Standards-aligned (recommended for new templates — mirrors x-pane-collections
//   on recordSchema):
//     { $schema, $defs: { TypeName: {...} },
//       x-pane-events: { "type.name": { payload: {$ref: "#/$defs/TypeName"}, emit: [...] } } }
//
// Both forms normalize to the same internal EventSchema repr so downstream
// code (validateEvent, schema-compat, etc.) is unchanged. Discriminator:
// presence of `x-pane-events` at the top level. A document with BOTH
// `x-pane-events` AND `events` is rejected — pick one.
//
// (Each type's payload must be a valid JSON Schema; types must be namespaced;
// emit / emittedBy must be a non-empty subset of {page, agent}.)
export function validateSchemaShape(raw: unknown): EventSchema {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw errors.invalidRequest("schema must be an object");
  }
  const doc = raw as Record<string, unknown>;

  // Discriminator: standards shape iff `x-pane-events` is present.
  if ("x-pane-events" in doc) {
    if ("events" in doc) {
      throw errors.invalidRequest(
        "schema cannot mix legacy `events` with standards-aligned `x-pane-events` — choose one",
      );
    }
    return validateStandardsEventSchema(doc);
  }

  // Fall through to the legacy shape.
  const s = raw as { events?: unknown };
  if (!s.events || typeof s.events !== "object" || Array.isArray(s.events)) {
    throw errors.invalidRequest("schema.events is required");
  }
  const eventsIn = s.events as Record<string, unknown>;
  const types = Object.keys(eventsIn);
  if (types.length === 0) {
    throw errors.invalidRequest("schema.events must declare at least one type");
  }

  const out: EventSchema = { events: {} };
  for (const [type, entryRaw] of Object.entries(eventsIn)) {
    if (!TYPE_RX.test(type)) {
      throw errors.invalidRequest(
        `schema.events: type "${type}" must match ${TYPE_RX}`,
      );
    }
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      throw errors.invalidRequest(`schema.events.${type} must be an object`);
    }
    const e = entryRaw as { payload?: unknown; emittedBy?: unknown };
    if (!e.payload || typeof e.payload !== "object") {
      throw errors.invalidRequest(
        `schema.events.${type}.payload must be an object`,
      );
    }
    if (!Array.isArray(e.emittedBy) || e.emittedBy.length === 0) {
      throw errors.invalidRequest(
        `schema.events.${type}.emittedBy must be a non-empty array`,
      );
    }
    const emittedBy: EmittedBy[] = [];
    for (const v of e.emittedBy) {
      if (v !== "page" && v !== "agent") {
        throw errors.invalidRequest(
          `schema.events.${type}.emittedBy values must be 'page' or 'agent'`,
        );
      }
      if (!emittedBy.includes(v)) emittedBy.push(v);
    }
    try {
      ajv.compile(e.payload);
    } catch (err) {
      throw errors.invalidRequest(
        `schema.events.${type}.payload is not a valid JSON Schema: ${(err as Error).message}`,
      );
    }
    out.events[type] = { payload: e.payload as object, emittedBy };
  }
  return out;
}

// #300 — parse the standards-aligned event schema (`x-pane-events` extension)
// and normalize to the same internal EventSchema repr the legacy shape
// produces. All downstream code (validateEvent, schema-compat, etc.) sees
// the same shape regardless of which form the template author chose.
//
// Document shape (mirrors x-pane-collections for recordSchema):
//
//   $schema: "https://json-schema.org/draft/2020-12/schema"
//   $defs:
//     ReviewSubmitted:
//       type: object
//       properties: { rating: { type: integer } }
//       required: [rating]
//   x-pane-events:
//     "review.submitted":
//       payload: { $ref: "#/$defs/ReviewSubmitted" }   # or an inline JSON Schema
//       emit:    [page]                                # subset of {agent, page}
//
// Inline payloads (no $ref) are accepted for terse single-use schemas.
// $ref must point inside the doc's $defs — no cross-doc refs in v1.
function validateStandardsEventSchema(
  doc: Record<string, unknown>,
): EventSchema {
  // Strict top-level keys.
  for (const k of Object.keys(doc)) {
    if (!STANDARDS_EVENT_SCHEMA_TOP_KEYS.has(k)) {
      throw errors.invalidRequest(
        `schema: unknown top-level key '${k}' (allowed: ${[...STANDARDS_EVENT_SCHEMA_TOP_KEYS].join(", ")})`,
      );
    }
  }

  const events = doc["x-pane-events"];
  if (!events || typeof events !== "object" || Array.isArray(events)) {
    throw errors.invalidRequest(
      "schema['x-pane-events'] is required and must be an object",
    );
  }
  const eventsObj = events as Record<string, unknown>;
  if (Object.keys(eventsObj).length === 0) {
    throw errors.invalidRequest(
      "schema['x-pane-events'] must declare at least one event type",
    );
  }

  const defs = (doc.$defs ?? {}) as Record<string, unknown>;
  const out: EventSchema = { events: {} };

  for (const [type, entryRaw] of Object.entries(eventsObj)) {
    if (!TYPE_RX.test(type)) {
      throw errors.invalidRequest(
        `schema['x-pane-events']: type "${type}" must match ${TYPE_RX}`,
      );
    }
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      throw errors.invalidRequest(
        `schema['x-pane-events'].${type} must be an object`,
      );
    }
    const entry = entryRaw as Record<string, unknown>;
    for (const k of Object.keys(entry)) {
      if (!STANDARDS_EVENT_ENTRY_KEYS.has(k)) {
        throw errors.invalidRequest(
          `schema['x-pane-events'].${type}: unknown key '${k}' (allowed: ${[...STANDARDS_EVENT_ENTRY_KEYS].join(", ")})`,
        );
      }
    }

    // payload: either a $ref into $defs OR an inline JSON Schema.
    const payloadRaw = entry.payload;
    if (
      !payloadRaw ||
      typeof payloadRaw !== "object" ||
      Array.isArray(payloadRaw)
    ) {
      throw errors.invalidRequest(
        `schema['x-pane-events'].${type}.payload must be an object (a $ref into $defs, or an inline JSON Schema)`,
      );
    }
    let resolvedPayload: object;
    const payloadObj = payloadRaw as Record<string, unknown>;
    if (typeof payloadObj["$ref"] === "string") {
      const refRaw = payloadObj["$ref"] as string;
      const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(refRaw);
      if (!m) {
        throw errors.invalidRequest(
          `schema['x-pane-events'].${type}.payload.$ref must match '#/$defs/<Name>' (cross-doc refs are not supported)`,
        );
      }
      const target = defs[m[1] as string];
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        throw errors.invalidRequest(
          `schema['x-pane-events'].${type}.payload.$ref '${refRaw}' does not resolve under $defs`,
        );
      }
      resolvedPayload = target as object;
    } else {
      resolvedPayload = payloadObj as object;
    }

    // Compile to confirm it's a valid JSON Schema — uses the 2020-12 Ajv
    // instance (same one recordSchema uses) so 2020-12-only vocabulary
    // (prefixItems, etc.) is accepted.
    try {
      ajv2020.compile(resolvedPayload);
    } catch (err) {
      throw errors.invalidRequest(
        `schema['x-pane-events'].${type}.payload is not a valid JSON Schema 2020-12: ${(err as Error).message}`,
      );
    }

    // emit: non-empty subset of {agent, page}.
    if (!Array.isArray(entry.emit) || entry.emit.length === 0) {
      throw errors.invalidRequest(
        `schema['x-pane-events'].${type}.emit must be a non-empty array`,
      );
    }
    const emittedBy: EmittedBy[] = [];
    for (const v of entry.emit as unknown[]) {
      if (typeof v !== "string" || !STANDARDS_EVENT_EMIT_PRINCIPALS.has(v)) {
        throw errors.invalidRequest(
          `schema['x-pane-events'].${type}.emit values must be 'page' or 'agent' (got '${String(v)}')`,
        );
      }
      if (!emittedBy.includes(v as EmittedBy)) {
        emittedBy.push(v as EmittedBy);
      }
    }

    out.events[type] = { payload: resolvedPayload, emittedBy };
  }

  return out;
}

// Allowed top-level keys on a recordSchema document. Strict — anything else
// is rejected so a typo doesn't get silently ignored.
const RECORD_SCHEMA_TOP_KEYS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$comment",
  "x-pane-collections",
]);
const RECORD_COLLECTION_KEYS = new Set(["schema", "write", "delete"]);
const RECORD_WRITE_PRINCIPALS = new Set(["agent", "page"]);
const RECORD_DELETE_PRINCIPALS = new Set(["agent", "page", "author"]);
// Snake-or-kebab collection name, 1-64 chars, must start with a lowercase letter.
const RECORD_COLLECTION_NAME_RX = /^[a-z][a-z0-9_-]{0,63}$/;

// Validate the *shape* of a recordSchema document at template-create / version
// time. The document is plain JSON Schema 2020-12, with one namespaced
// extension — `x-pane-collections` — that declares the template's record
// collections + their per-operation authz. Standards-first by design: agents
// writing templates only need to learn the one extension keyword; everything
// else is JSON Schema as they already know it. See epic #287 for the rationale.
//
// What we enforce here is the *document shape* — strict top-level keys, strict
// collection sub-keys, principal allowlists, and that each declared collection's
// schema $ref resolves to a valid JSON Schema under $defs. Compiled validators
// are discarded; the per-write validator (`validateRecord`, follow-up PR after
// #288 lands) will set up its own LRU cache keyed by pane + collection.
export function validateRecordSchemaShape(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw errors.invalidRequest("record_schema must be an object");
  }
  const doc = raw as Record<string, unknown>;

  for (const k of Object.keys(doc)) {
    if (!RECORD_SCHEMA_TOP_KEYS.has(k)) {
      throw errors.invalidRequest(
        `record_schema: unknown top-level key '${k}' (allowed: ${[...RECORD_SCHEMA_TOP_KEYS].join(", ")})`,
      );
    }
  }

  const collections = doc["x-pane-collections"];
  if (
    !collections ||
    typeof collections !== "object" ||
    Array.isArray(collections)
  ) {
    throw errors.invalidRequest(
      "record_schema['x-pane-collections'] is required and must be an object",
    );
  }
  const collectionsObj = collections as Record<string, unknown>;
  if (Object.keys(collectionsObj).length === 0) {
    throw errors.invalidRequest(
      "record_schema['x-pane-collections'] must declare at least one collection",
    );
  }

  const defs = (doc.$defs ?? {}) as Record<string, unknown>;

  for (const [name, entryRaw] of Object.entries(collectionsObj)) {
    if (!RECORD_COLLECTION_NAME_RX.test(name)) {
      throw errors.invalidRequest(
        `record_schema['x-pane-collections']: collection name '${name}' must match ${RECORD_COLLECTION_NAME_RX}`,
      );
    }
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      throw errors.invalidRequest(
        `record_schema['x-pane-collections'].${name} must be an object`,
      );
    }
    const entry = entryRaw as Record<string, unknown>;
    for (const k of Object.keys(entry)) {
      if (!RECORD_COLLECTION_KEYS.has(k)) {
        throw errors.invalidRequest(
          `record_schema['x-pane-collections'].${name}: unknown key '${k}' (allowed: ${[...RECORD_COLLECTION_KEYS].join(", ")})`,
        );
      }
    }

    const schemaRef = entry.schema;
    if (
      !schemaRef ||
      typeof schemaRef !== "object" ||
      Array.isArray(schemaRef)
    ) {
      throw errors.invalidRequest(
        `record_schema['x-pane-collections'].${name}.schema is required and must be an object`,
      );
    }
    const refRaw = (schemaRef as Record<string, unknown>).$ref;
    if (typeof refRaw !== "string") {
      throw errors.invalidRequest(
        `record_schema['x-pane-collections'].${name}.schema.$ref is required and must be a string`,
      );
    }
    const refMatch = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(refRaw);
    if (!refMatch) {
      throw errors.invalidRequest(
        `record_schema['x-pane-collections'].${name}.schema.$ref must match '#/$defs/<Name>' (cross-doc refs are not supported)`,
      );
    }
    // refMatch[1] is the capture group; the regex guarantees it's present
    // when refMatch is truthy, but noUncheckedIndexedAccess types it as
    // possibly-undefined.
    const defName = refMatch[1] as string;
    const rowSchema = defs[defName];
    if (
      !rowSchema ||
      typeof rowSchema !== "object" ||
      Array.isArray(rowSchema)
    ) {
      throw errors.invalidRequest(
        `record_schema['x-pane-collections'].${name}.schema.$ref '${refRaw}' does not resolve under $defs`,
      );
    }

    try {
      ajv2020.compile(rowSchema as object);
    } catch (err) {
      throw errors.invalidRequest(
        `record_schema['x-pane-collections'].${name}.schema ('${refRaw}') does not compile as JSON Schema 2020-12: ${(err as Error).message}`,
      );
    }

    if (!Array.isArray(entry.write) || entry.write.length === 0) {
      throw errors.invalidRequest(
        `record_schema['x-pane-collections'].${name}.write must be a non-empty array`,
      );
    }
    for (const v of entry.write as unknown[]) {
      if (typeof v !== "string" || !RECORD_WRITE_PRINCIPALS.has(v)) {
        throw errors.invalidRequest(
          `record_schema['x-pane-collections'].${name}.write values must be 'agent' or 'page' (got '${String(v)}')`,
        );
      }
    }

    if (!Array.isArray(entry.delete) || entry.delete.length === 0) {
      throw errors.invalidRequest(
        `record_schema['x-pane-collections'].${name}.delete must be a non-empty array`,
      );
    }
    for (const v of entry.delete as unknown[]) {
      if (typeof v !== "string" || !RECORD_DELETE_PRINCIPALS.has(v)) {
        throw errors.invalidRequest(
          `record_schema['x-pane-collections'].${name}.delete values must be 'agent', 'page', or 'author' (got '${String(v)}')`,
        );
      }
    }
  }
}

// Compile an template's `input_schema` to confirm it is a valid JSON Schema.
// Used by the /v1/templates routes at create/version time so a malformed
// input_schema is rejected up front rather than at pane-create time. The
// schema itself is not retained — only its validity is asserted here. Phase C
// will use the compiled validator to check pane.input_data.
export function assertValidInputSchema(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw errors.invalidRequest("input_schema must be an object");
  }
  try {
    ajv.compile(raw as object);
  } catch (err) {
    throw errors.invalidRequest(
      `input_schema is not a valid JSON Schema: ${(err as Error).message}`,
    );
  }
}

// Validate a pane's `input_data` against the pinned template version's
// `input_schema` (a JSON Schema object). Called at POST /v1/panes time so a
// bad request fails fast — with a clear 422, exactly like a rejected event —
// before any pane row is created. `inputSchema` must already be a valid
// JSON Schema (the /v1/templates routes enforce that via assertValidInputSchema
// at template-write time). `data` is validated as-is; a caller that supplied no
// `input_data` should pass `{}` so the schema's `required` fields fail
// naturally rather than this throwing on undefined. Reuses the single shared
// `ajv` instance — no second instance is created.
export function validateInputData(inputSchema: object, data: unknown): void {
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(inputSchema);
  } catch (err) {
    // Should not happen — input_schema is validated at template-write time —
    // but if a malformed schema ever reaches here, pane it as a 400 rather
    // than letting Ajv throw an unhandled error.
    throw errors.invalidRequest(
      `input_schema is not a valid JSON Schema: ${(err as Error).message}`,
    );
  }
  if (!validate(data)) {
    throw errors.schemaViolation(
      "input_schema_violation",
      validate.errors,
      "input_data does not validate against the template version's input_schema; see details for the failing JSON Schema paths, and check the schema for required fields",
    );
  }
}

// Additive merge: the patch may only ADD new event types. Re-declaring an
// existing type (even with an identical payload schema) is rejected — clients
// pinned to an older `schemaVersion` would break if the payload shape changed,
// and we don't try to prove deep JSON-Schema compatibility here.
//
// Note: `prev` is typed `EventSchema` (non-null). A schemaless (view-only)
// `prev` is not currently reachable — there is no schema-PATCH route, and a
// view-only pane has no event vocabulary to extend. A future PATCH route
// that wants to let a view-only template gain a schema must decide the
// semantics (a first PATCH could *establish* a schema rather than merge).
export function mergeSchemaAdditive(
  prev: EventSchema,
  patch: { events?: Record<string, unknown> },
): EventSchema {
  const patchEvents = patch.events ?? {};
  for (const t of Object.keys(patchEvents)) {
    if (prev.events[t]) {
      throw errors.invalidRequest(
        `schema.events.${t} already exists; patch can only add new types (additive only)`,
      );
    }
  }
  // No overlap by construction; validate the shape of the combined schema.
  return validateSchemaShape({ events: { ...prev.events, ...patchEvents } });
}
