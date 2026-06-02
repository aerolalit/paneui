// Aggregate the caller's per-pane record/event schemas into one fingerprint,
// then emit the CREATE VIEW DDL that exposes each collection + event type
// as a normal SQL table.
//
// The caller's scope may span N panes built from M template versions, each
// with their own `record_schema` (under `x-pane-collections`) and
// `event_schema`. This module:
//
//   1. Walks every template_version's schemas and builds a union of:
//      - collection name → list of unique CompiledColumn objects (by name)
//      - event type     → list of unique CompiledColumn objects (by name)
//   2. Detects type conflicts (same column name, two different sqlType
//      across the panes). Phase 2 errors out on conflict with a clear
//      hint to `pane query --pane <id>` (#355 future-work item). Same-
//      column-same-type unifies cleanly.
//   3. Emits `CREATE VIEW <table> AS SELECT … FROM _record_raw WHERE
//      collection = '<n>'` (or `_event_raw WHERE type = '<t>'`) — Phase 1
//      already exposes those tables.
//
// Schema fingerprinting is exposed so the engine (and a future cache) can
// reason about equivalence across requests without re-walking the JSON.

import {
  compileSchemaToColumns,
  quoteIdent,
  slugifyEventType,
  viewNameForCollection,
  type CompiledColumn,
  type SqlType,
} from "./schema-compiler.js";

export interface PerCollectionView {
  /** The collection name as declared in `x-pane-collections`. */
  collection: string;
  /** The SQL view name (collection name with `-` → `_`). */
  viewName: string;
  /** Union of typed columns across every pane's schema for this collection. */
  columns: CompiledColumn[];
}

export interface PerEventTypeView {
  /** The event type as it appears in the event_schema, e.g. `todo.added`. */
  eventType: string;
  /** The SQL view name (dots → underscores). */
  viewName: string;
  /** Union of typed columns across every template_version's schema. */
  columns: CompiledColumn[];
}

export interface SchemaFingerprint {
  /** Materialized views to expose, one per collection. */
  collections: PerCollectionView[];
  /** Materialized views to expose, one per event type. */
  eventTypes: PerEventTypeView[];
  /**
   * Conflicts the materialiser refused to merge. Empty array on a clean
   * fingerprint. Non-empty → engine raises view_conflict to the caller.
   */
  conflicts: SchemaConflict[];
}

export interface SchemaConflict {
  scope: "collection" | "event_type";
  /** Collection name or event type that conflicts. */
  name: string;
  /** Column where the type disagrees. */
  column: string;
  /** Distinct types seen across the caller's panes. */
  seenTypes: SqlType[];
}

// Minimal shape of a template version's schemas. Engine populates this
// from the Prisma query that fetches the caller's panes.
export interface TemplateVersionSchemas {
  recordSchema: unknown;
  eventSchema: unknown;
}

// Build the per-collection + per-event-type fingerprint by walking every
// template version's record_schema and event_schema. Same column name +
// same SQL type merges; different SQL types flag a conflict that callers
// resolve by scoping the query to a single pane.
export function buildSchemaFingerprint(
  versions: TemplateVersionSchemas[],
): SchemaFingerprint {
  // collection-name → column-name → sqlType (first seen)
  const collectionColumns = new Map<string, Map<string, CompiledColumn>>();
  const eventColumns = new Map<string, Map<string, CompiledColumn>>();
  const conflicts: SchemaConflict[] = [];

  for (const v of versions) {
    walkRecordSchema(v.recordSchema, collectionColumns, conflicts);
    walkEventSchema(v.eventSchema, eventColumns, conflicts);
  }

  return {
    collections: Array.from(collectionColumns.entries()).map(
      ([name, cols]) => ({
        collection: name,
        viewName: viewNameForCollection(name),
        columns: Array.from(cols.values()),
      }),
    ),
    eventTypes: Array.from(eventColumns.entries()).map(([type, cols]) => ({
      eventType: type,
      viewName: slugifyEventType(type),
      columns: Array.from(cols.values()),
    })),
    conflicts,
  };
}

// Walk a single template version's record_schema and merge each collection's
// columns into `acc`. Conflicts on type are appended to `conflictsOut`.
function walkRecordSchema(
  recordSchema: unknown,
  acc: Map<string, Map<string, CompiledColumn>>,
  conflictsOut: SchemaConflict[],
): void {
  if (!isJsonObject(recordSchema)) return;
  const collections = recordSchema["x-pane-collections"];
  if (!isJsonObject(collections)) return;

  for (const [collectionName, collectionDecl] of Object.entries(collections)) {
    if (!isJsonObject(collectionDecl)) continue;
    const schemaEntry = collectionDecl["schema"];
    if (!isJsonObject(schemaEntry)) continue;
    const compiled = compileSchemaToColumns(schemaEntry, recordSchema);
    mergeColumnsInto(
      "collection",
      collectionName,
      compiled.columns,
      acc,
      conflictsOut,
    );
  }
}

// Walk a single template version's event_schema. Supports both the legacy
// shape (top-level `events: { <type>: { payload, emittedBy } }`) and the
// standards-aligned `x-pane-events` shape (#300).
function walkEventSchema(
  eventSchema: unknown,
  acc: Map<string, Map<string, CompiledColumn>>,
  conflictsOut: SchemaConflict[],
): void {
  if (!isJsonObject(eventSchema)) return;

  // Standards-aligned: x-pane-events at the top level alongside $defs.
  const xEvents = eventSchema["x-pane-events"];
  if (isJsonObject(xEvents)) {
    for (const [eventType, decl] of Object.entries(xEvents)) {
      if (!isJsonObject(decl)) continue;
      const payload = decl["schema"] ?? decl["payload"];
      if (!isJsonObject(payload)) continue;
      const compiled = compileSchemaToColumns(payload, eventSchema);
      mergeColumnsInto(
        "event_type",
        eventType,
        compiled.columns,
        acc,
        conflictsOut,
      );
    }
    return;
  }

  // Legacy: top-level `events` map.
  const events = eventSchema["events"];
  if (isJsonObject(events)) {
    for (const [eventType, decl] of Object.entries(events)) {
      if (!isJsonObject(decl)) continue;
      const payload = decl["payload"];
      if (!isJsonObject(payload)) continue;
      const compiled = compileSchemaToColumns(payload, eventSchema);
      mergeColumnsInto(
        "event_type",
        eventType,
        compiled.columns,
        acc,
        conflictsOut,
      );
    }
  }
}

function mergeColumnsInto(
  scope: "collection" | "event_type",
  name: string,
  newColumns: CompiledColumn[],
  acc: Map<string, Map<string, CompiledColumn>>,
  conflictsOut: SchemaConflict[],
): void {
  let bucket = acc.get(name);
  if (!bucket) {
    bucket = new Map();
    acc.set(name, bucket);
  }
  for (const col of newColumns) {
    const existing = bucket.get(col.name);
    if (!existing) {
      bucket.set(col.name, col);
      continue;
    }
    if (existing.sqlType !== col.sqlType) {
      // Two panes describe `<name>.<col>` with different SQL types.
      // Keep the first-seen type in the bucket; record the conflict
      // (so the engine can refuse with a clear error). Don't push
      // duplicate conflicts for the same (scope, name, column).
      if (
        !conflictsOut.some(
          (c) => c.scope === scope && c.name === name && c.column === col.name,
        )
      ) {
        conflictsOut.push({
          scope,
          name,
          column: col.name,
          seenTypes: [existing.sqlType, col.sqlType],
        });
      } else {
        // Already flagged; just append the additional type if new.
        const conflict = conflictsOut.find(
          (c) => c.scope === scope && c.name === name && c.column === col.name,
        )!;
        if (!conflict.seenTypes.includes(col.sqlType)) {
          conflict.seenTypes.push(col.sqlType);
        }
      }
      continue;
    }
    // Same column name + same SQL type — keep the more permissive
    // nullability (required becomes optional if any pane omits it).
    if (existing.required && !col.required) {
      bucket.set(col.name, { ...existing, required: false });
    }
  }
}

// Emit the CREATE VIEW DDL for the per-collection and per-event-type views.
// Caller writes these to DuckDB after the three generic _raw views are
// already in place.
//
// Each per-collection view shape is:
//
//   CREATE VIEW <collection_view_name> AS SELECT
//     <extract_expr> AS <col>, ...           -- user-schema columns
//     key,                                   -- record_key (unprefixed)
//     pane_id,                               -- which pane
//     p.title AS pane_title,                 -- convenience join
//     created_at AS _created_at,
//     updated_at AS _updated_at,
//     version    AS _version,
//     seq        AS _seq,
//     author_kind AS _author,
//     (deleted_at IS NOT NULL) AS _deleted
//   FROM _record_raw r
//   LEFT JOIN _pane_raw p ON p.id = r.pane_id
//   WHERE collection = '<name>'
//
// Per-event-type views are similar but project event-payload fields and
// omit the record-specific metadata.
export function buildViewDdl(fingerprint: SchemaFingerprint): string[] {
  const ddl: string[] = [];

  for (const view of fingerprint.collections) {
    ddl.push(buildCollectionView(view));
  }
  for (const view of fingerprint.eventTypes) {
    ddl.push(buildEventTypeView(view));
  }

  return ddl;
}

function buildCollectionView(view: PerCollectionView): string {
  const userCols = view.columns
    .map(
      (c) =>
        `  ${c.extractExpr.replace(/\bdata\b/g, "r.data")} AS ${quoteIdent(c.name)}`,
    )
    .join(",\n");
  const userColsBlock = userCols ? userCols + ",\n" : "";
  return `CREATE VIEW ${quoteIdent(view.viewName)} AS SELECT
${userColsBlock}  r.key AS key,
  r.pane_id AS pane_id,
  p.title AS pane_title,
  r.created_at AS _created_at,
  r.updated_at AS _updated_at,
  r.version AS _version,
  r.seq AS _seq,
  r.author_kind AS _author,
  (r.deleted_at IS NOT NULL) AS _deleted
FROM _record_raw r
LEFT JOIN _pane_raw p ON p.id = r.pane_id
WHERE r.collection = '${escapeStringLiteral(view.collection)}'`;
}

function buildEventTypeView(view: PerEventTypeView): string {
  const userCols = view.columns
    .map(
      (c) =>
        `  ${c.extractExpr.replace(/\bdata\b/g, "e.data")} AS ${quoteIdent(c.name)}`,
    )
    .join(",\n");
  const userColsBlock = userCols ? userCols + ",\n" : "";
  return `CREATE VIEW ${quoteIdent(view.viewName)} AS SELECT
${userColsBlock}  e.id AS id,
  e.pane_id AS pane_id,
  p.title AS pane_title,
  e.ts AS ts,
  e.author_kind AS _author,
  e.author_id AS _author_id,
  e.template_version_id AS _template_version_id
FROM _event_raw e
LEFT JOIN _pane_raw p ON p.id = e.pane_id
WHERE e.type = '${escapeStringLiteral(view.eventType)}'`;
}

function escapeStringLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
