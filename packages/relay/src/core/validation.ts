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
  if (hit) return hit;
  const m = new Map<string, ValidateFunction>();
  for (const [type, entry] of Object.entries(schema.events)) {
    m.set(type, ajv.compile(entry.payload));
  }
  cache.set(k, m);
  return m;
}

export function invalidateSchemaCache(sessionId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${sessionId}:`)) cache.delete(k);
  }
}

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
