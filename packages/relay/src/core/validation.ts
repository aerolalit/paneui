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
// Both schema_violation (event data) and input_schema_violation (surface
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

// `format: pane-attachment-id` — schema vocabulary for attachment references inside
// event payloads + input_data. The format is purely SYNTACTIC: a cuid-
// shaped string. The relay's authoritative access check (does this attachment
// exist? does the calling agent own it? is the scope compatible with this
// surface?) lives in the route layer because Ajv format validators are
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

// Compiled-validator cache, keyed by `${surfaceId}:${schemaVersion}`. Entries
// are explicitly dropped via invalidateSchemaCache — on surface DELETE and on
// TTL expiry (the sweeper collects swept surface ids and invalidates each).
// As a backstop against any path that fails to invalidate, the cache is also
// bounded so it can't leak unboundedly: it is a simple LRU — a JS Map preserves
// insertion order, so "least recently used" = the first key; on a hit we
// delete + re-set to move the entry to the most-recent position.
const CACHE_MAX = 10_000;
const cache = new Map<string, Map<string, ValidateFunction>>();
const cacheKey = (surfaceId: string, schemaVersion: number): string =>
  `${surfaceId}:${schemaVersion}`;

function getCompilers(
  surfaceId: string,
  schemaVersion: number,
  schema: EventSchema,
): Map<string, ValidateFunction> {
  const k = cacheKey(surfaceId, schemaVersion);
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

export function invalidateSchemaCache(surfaceId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${surfaceId}:`)) cache.delete(k);
  }
}

// Test-only introspection of the compiled-validator LRU. Not part of the
// public API — exported solely so the unit test can assert eviction and
// recency behaviour without compiling 10k schemas.
export const __schemaCacheInternals = {
  max: CACHE_MAX,
  size: (): number => cache.size,
  has: (surfaceId: string, schemaVersion: number): boolean =>
    cache.has(cacheKey(surfaceId, schemaVersion)),
  clear: (): void => cache.clear(),
};

export interface ValidateEventArgs {
  surfaceId: string;
  schemaVersion: number;
  // `null` = the pinned template version declares no event schema (a view-only
  // template). validateEvent rejects every page/agent emit against such a
  // surface; only system events flow (they bypass validateEvent entirely).
  schema: EventSchema | null;
  type: string;
  data: unknown;
  authorKind: AuthorKind;
}

// Namespaced event types: start lowercase, then alnum or dot, end alnum.
// camelCase second segments (e.g. `review.commentAdded`) are allowed.
const TYPE_RX = /^[a-z][a-zA-Z0-9.]*[a-zA-Z0-9]$/;

export function validateEvent(args: ValidateEventArgs): void {
  // A schemaless surface is view-only: it declares an empty event vocabulary,
  // strictly enforced. Every page/agent emit is rejected — there is no type it
  // could possibly match. System events never reach here (appendSystemEvent
  // writes directly), so the `!== "system"` guard is belt-and-braces.
  if (args.schema === null) {
    if (args.authorKind !== "system") {
      throw errors.schemaViolation(
        "unknown_event_type",
        { type: args.type },
        "this surface declares no event schema; it is view-only and accepts no page/agent events",
      );
    }
    // A system author against a schemaless surface: nothing to validate
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
      `event type '${args.type}' is not declared in the surface schema; emit a declared type or PATCH the schema to add it`,
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

  const compilers = getCompilers(args.surfaceId, args.schemaVersion, schema);
  const validate = compilers.get(args.type)!;
  if (!validate(args.data)) {
    throw errors.schemaViolation(
      "schema_violation",
      validate.errors,
      `event data does not validate against the payload schema for type '${args.type}'; see details for the failing JSON Schema paths`,
    );
  }
}

// Validate an agent-supplied surface title. Trust boundary: this value is
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

// Validate the *shape* of an event schema at surface-create / schema-patch time.
// (Each type's payload must be a valid JSON Schema; types must be namespaced;
// emittedBy must be a non-empty subset of {page, agent}.)
export function validateSchemaShape(raw: unknown): EventSchema {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw errors.invalidRequest("schema must be an object");
  }
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

// Compile an template's `input_schema` to confirm it is a valid JSON Schema.
// Used by the /v1/templates routes at create/version time so a malformed
// input_schema is rejected up front rather than at surface-create time. The
// schema itself is not retained — only its validity is asserted here. Phase C
// will use the compiled validator to check surface.input_data.
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

// Validate a surface's `input_data` against the pinned template version's
// `input_schema` (a JSON Schema object). Called at POST /v1/surfaces time so a
// bad request fails fast — with a clear 422, exactly like a rejected event —
// before any surface row is created. `inputSchema` must already be a valid
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
    // but if a malformed schema ever reaches here, surface it as a 400 rather
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
// view-only surface has no event vocabulary to extend. A future PATCH route
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
