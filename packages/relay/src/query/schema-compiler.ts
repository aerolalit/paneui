// JSON Schema → SQL column compiler for the per-collection / per-event-type
// materialized views (Phase 2 of #355).
//
// Takes a JSON Schema 2020-12 document (the per-collection `schema` block
// from `record_schema['x-pane-collections']`, or an event payload schema)
// and produces:
//
//   - the list of typed SQL columns to expose ({ name, sqlType, extractExpr })
//   - the set of unresolved $ref names (caller can flag them)
//
// `$ref` resolves only against `#/$defs/<Name>` inside the same document —
// matches the relay's existing convention (see core/validation.ts). Cross-
// document refs and JSON Pointer fragments are not supported in Phase 2.
//
// Unsupported JSON Schema features (additionalProperties, oneOf/anyOf, etc.)
// are tolerated — properties they don't describe simply don't get a column,
// and the agent can still reach those fields through json_extract(data, '$.x')
// against the generic `records` view.

export interface CompiledColumn {
  /** User-facing column name in the materialized view. */
  name: string;
  /** SQL type emitted in the CREATE VIEW DDL. */
  sqlType: SqlType;
  /**
   * The SQL expression that extracts this column from the underlying
   * `data` JSON blob, e.g. `json_extract_string(data, '$.title')`. The view
   * builder wraps this in `<expr> AS <quoted name>`.
   */
  extractExpr: string;
  /** True if the schema declares this property as required (NOT NULL). */
  required: boolean;
}

export type SqlType =
  | "TEXT"
  | "BIGINT"
  | "DOUBLE"
  | "BOOLEAN"
  | "TIMESTAMP"
  | "JSON";

export interface CompileResult {
  columns: CompiledColumn[];
  /**
   * Any `$ref` paths that couldn't be resolved against the document's
   * `$defs`. Empty array on a clean schema.
   */
  unresolvedRefs: string[];
}

interface JsonSchemaDoc {
  $defs?: Record<string, JsonSchemaNode>;
  // The "root" schema can also be the entry directly (i.e. without $ref):
  // properties/required/type all read off it.
  [k: string]: unknown;
}

interface JsonSchemaNode {
  $ref?: string;
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  // Tolerated but not used yet:
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
}

// Compile the schema rooted at `entry` (a property schema or a $ref to one)
// against the surrounding document `doc` (so $refs can resolve). The most
// common shape used in pane today is:
//
//   doc      = { $defs: { Todo: { type: 'object', properties: { ... } } } }
//   entry    = { $ref: '#/$defs/Todo' }
//
// but the entry could also be inline (no $ref).
export function compileSchemaToColumns(
  entry: JsonSchemaNode,
  doc: JsonSchemaDoc,
): CompileResult {
  const unresolved: string[] = [];
  const resolved = resolveRef(entry, doc, unresolved);
  if (resolved === null) {
    return { columns: [], unresolvedRefs: unresolved };
  }

  const properties = resolved.properties ?? {};
  const required = new Set(resolved.required ?? []);
  const columns: CompiledColumn[] = [];

  for (const [propName, propSchema] of Object.entries(properties)) {
    const resolvedProp = resolveRef(propSchema, doc, unresolved);
    if (resolvedProp === null) continue;
    const sqlType = jsonSchemaToSqlType(resolvedProp);
    columns.push({
      name: propName,
      sqlType,
      extractExpr: extractExprForType(sqlType, propName),
      required: required.has(propName),
    });
  }

  return { columns, unresolvedRefs: unresolved };
}

// Resolve a node that may be `{ $ref: '#/$defs/X' }` into the actual schema
// from `doc.$defs.X`. Pushes the unresolved ref string onto `unresolved`
// if the lookup fails. Returns null if the node is a $ref that we couldn't
// resolve (caller decides whether to skip that property or error).
function resolveRef(
  node: JsonSchemaNode,
  doc: JsonSchemaDoc,
  unresolved: string[],
): JsonSchemaNode | null {
  if (typeof node.$ref !== "string") return node;
  const REF_PREFIX = "#/$defs/";
  if (!node.$ref.startsWith(REF_PREFIX)) {
    unresolved.push(node.$ref);
    return null;
  }
  const name = node.$ref.slice(REF_PREFIX.length);
  const target = doc.$defs?.[name];
  if (target === undefined) {
    unresolved.push(node.$ref);
    return null;
  }
  return target;
}

function jsonSchemaToSqlType(schema: JsonSchemaNode): SqlType {
  // Take the first listed type if `type` is an array (JSON Schema allows
  // type unions; we collapse to the most permissive). string-with-format
  // 'date-time' becomes TIMESTAMP, everything else string stays TEXT.
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t) {
    case "string":
      if (schema.format === "date-time" || schema.format === "date") {
        return "TIMESTAMP";
      }
      return "TEXT";
    case "integer":
      return "BIGINT";
    case "number":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "array":
    case "object":
      return "JSON";
    default:
      // Unknown / missing type — expose as JSON so the agent can still
      // reach into it with json_extract().
      return "JSON";
  }
}

// DuckDB's JSON access functions. The relay loads the source column as the
// DuckDB type `JSON`, which behaves like a string at the SQL surface; the
// `json_extract*` helpers do the right thing for each leaf type.
function extractExprForType(sqlType: SqlType, propName: string): string {
  const path = `'$.${escapeJsonPath(propName)}'`;
  switch (sqlType) {
    case "TEXT":
      return `json_extract_string(data, ${path})`;
    case "BIGINT":
      return `CAST(json_extract(data, ${path}) AS BIGINT)`;
    case "DOUBLE":
      return `CAST(json_extract(data, ${path}) AS DOUBLE)`;
    case "BOOLEAN":
      return `CAST(json_extract(data, ${path}) AS BOOLEAN)`;
    case "TIMESTAMP":
      return `CAST(json_extract_string(data, ${path}) AS TIMESTAMP)`;
    case "JSON":
      return `json_extract(data, ${path})`;
  }
}

// Escape JSON path segments. We only support flat property names today
// (no nested objects in the column projection — the agent uses ->/->> on the
// resulting JSON column for that), so this is just an apostrophe escape.
function escapeJsonPath(propName: string): string {
  return propName.replace(/'/g, "''");
}

// Quote an SQL identifier with double-quotes. Used in the CREATE VIEW DDL
// to make collection/property names like `order` or `select` safe.
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Slug a possibly-dotted event type into a SQL-identifier-safe name.
// `todo.added` → `todo_added`; `payment.intent.succeeded` → `payment_intent_succeeded`.
// Returns the original string unchanged if it's already a clean identifier.
export function slugifyEventType(type: string): string {
  return type.replace(/[^a-zA-Z0-9_]/g, "_");
}

// Sanity-check that a collection name is safe to use as a view name. We
// validate at template create time (`/^[a-z][a-z0-9_-]{0,63}$/` per the
// records schema validator), but dashes need to become underscores for the
// SQL identifier; this helper normalizes.
export function viewNameForCollection(collection: string): string {
  return collection.replace(/-/g, "_");
}
