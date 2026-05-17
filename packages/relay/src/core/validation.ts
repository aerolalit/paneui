import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { AuthorKind, EmittedBy, EventSchema } from "../types.js";
import { errors } from "../http/errors.js";

// Ajv v8 ships as CJS; under "module": "NodeNext" the default import sometimes
// resolves to the namespace, not the constructor. createRequire bypasses that.
const require = createRequire(import.meta.url);

const AjvCtor: new (opts?: object) => {
  compile: (schema: object) => ValidateFunction;
} = require("ajv");

const ajv = new AjvCtor({
  strict: false,
  allErrors: false,
  removeAdditional: false,
});

// Compiled-validator cache, keyed by `${sessionId}:${schemaVersion}`. Entries
// are explicitly dropped on session DELETE (invalidateSchemaCache), but NOT on
// natural TTL expiry — the TTL sweeper does a bulk deleteMany and never learns
// the individual expired session ids, so it can't invalidate per-session.
// Without a bound, a long-running relay would leak one compiled entry per
// expired session forever. So the cache is a simple LRU: a JS Map preserves
// insertion order, so "least recently used" = the first key; on a hit we
// delete + re-set to move the entry to the most-recent position.
const CACHE_MAX = 10_000;
const cache = new Map<string, Map<string, ValidateFunction>>();
const cacheKey = (sessionId: string, schemaVersion: number): string =>
  `${sessionId}:${schemaVersion}`;

function getCompilers(
  sessionId: string,
  schemaVersion: number,
  schema: EventSchema,
): Map<string, ValidateFunction> {
  const k = cacheKey(sessionId, schemaVersion);
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

export function invalidateSchemaCache(sessionId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${sessionId}:`)) cache.delete(k);
  }
}

// Test-only introspection of the compiled-validator LRU. Not part of the
// public API — exported solely so the unit test can assert eviction and
// recency behaviour without compiling 10k schemas.
export const __schemaCacheInternals = {
  max: CACHE_MAX,
  size: (): number => cache.size,
  has: (sessionId: string, schemaVersion: number): boolean =>
    cache.has(cacheKey(sessionId, schemaVersion)),
  clear: (): void => cache.clear(),
};

export interface ValidateEventArgs {
  sessionId: string;
  schemaVersion: number;
  schema: EventSchema;
  type: string;
  data: unknown;
  authorKind: AuthorKind;
}

// Namespaced event types: start lowercase, then alnum or dot, end alnum.
// camelCase second segments (e.g. `review.commentAdded`) are allowed.
const TYPE_RX = /^[a-z][a-zA-Z0-9.]*[a-zA-Z0-9]$/;

export function validateEvent(args: ValidateEventArgs): void {
  const entry = args.schema.events[args.type];
  if (!entry) {
    throw errors.schemaViolation(
      "unknown_event_type",
      { type: args.type },
      `event type '${args.type}' is not declared in the session schema; emit a declared type or PATCH the schema to add it`,
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

  const compilers = getCompilers(
    args.sessionId,
    args.schemaVersion,
    args.schema,
  );
  const validate = compilers.get(args.type)!;
  if (!validate(args.data)) {
    throw errors.schemaViolation(
      "schema_violation",
      validate.errors,
      `event data does not validate against the payload schema for type '${args.type}'; see details for the failing JSON Schema paths`,
    );
  }
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

// Validate the *shape* of an event schema at session-create / schema-patch time.
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

// Additive merge: the patch may only ADD new event types. Re-declaring an
// existing type (even with an identical payload schema) is rejected — clients
// pinned to an older `schemaVersion` would break if the payload shape changed,
// and we don't try to prove deep JSON-Schema compatibility here.
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
