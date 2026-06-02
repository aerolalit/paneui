// The query engine. Per-request:
//
//   1. Resolve the caller's scope to a set of pane ids (see scope.ts).
//   2. Load the panes / records / events for those ids from the relay's
//      live Postgres/SQLite into a fresh in-memory DuckDB instance.
//   3. Build three scoped views: `panes`, `records`, `events`. (Phase 2
//      will materialize per-collection / per-event-type views on top.)
//   4. Run the agent's validated SQL against that schema.
//   5. Return columns + rows, capped at OUTPUT_ROW_CAP.
//   6. Tear down the DuckDB instance.
//
// The data ships from the relay's DB into DuckDB on every query — wasteful
// at scale, but the simplest secure thing for Phase 1. Phase 3 adds a cache
// keyed on (humanId, schemaFingerprint).
//
// Note on safety: the DuckDB instance is ephemeral and in-memory; the agent's
// SQL can't reach the underlying relay DB. Any "SELECT * FROM panes_raw"-type
// escape attempt errors with "relation does not exist" because the agent
// never sees a connection to anything beyond their throwaway DuckDB session.

import { DuckDBInstance } from "@duckdb/node-api";
import type { PrismaClient } from "@prisma/client";
import {
  resolveScope,
  type ScopedCaller,
  type ResolvedScope,
} from "./scope.js";
import { validateAgentSql } from "./parser.js";
import {
  buildSchemaFingerprint,
  buildViewDdl,
  type TemplateVersionSchemas,
} from "./view-builder.js";

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  scope: { kind: "human" | "agent"; pane_count: number };
  elapsed_ms: number;
}

export interface QueryEngineError {
  code: string;
  message: string;
  hint?: string;
}

export class QueryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "QueryError";
  }
}

// Implicit LIMIT on the agent's result set. Larger result sets are valid
// data shapes (e.g. exporting events) but they signal the agent should
// paginate or pre-aggregate. The cap is reported via `truncated: true` so
// the agent can detect it.
const OUTPUT_ROW_CAP = 10_000;

// Statement timeout passed to DuckDB. Above this the engine errors with
// code `query_timeout`.
const STATEMENT_TIMEOUT_MS = 10_000;

// Belt-and-braces row cap on the underlying SQL — Phase 1 fetches the
// caller's entire scoped dataset, which would blow up for very active
// accounts. Beyond this the engine returns a `scope_too_large` error and
// asks the caller to scope by --pane.
const SCOPE_RECORD_CAP = 200_000;
const SCOPE_EVENT_CAP = 200_000;

interface ScopedData {
  scope: ResolvedScope;
  panes: PaneRow[];
  records: RecordRow[];
  events: EventRow[];
  /**
   * Unique template versions referenced by the caller's panes, with their
   * record/event schemas. Dedup'd by templateVersionId — many panes can
   * share the same version. Drives the per-collection view materialiser.
   */
  templateVersions: TemplateVersionSchemas[];
}

interface PaneRow {
  id: string;
  title: string | null;
  template_id: string | null;
  template_version: number;
  status: string;
  created_at: Date;
  expires_at: Date;
  deleted_at: Date | null;
  metadata: unknown;
  input_data: unknown;
}

interface RecordRow {
  id: string;
  pane_id: string;
  collection: string;
  key: string;
  data: unknown;
  version: number;
  seq: number;
  author_kind: string;
  author_id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface EventRow {
  id: number;
  pane_id: string;
  type: string;
  ts: Date;
  author_kind: string;
  author_id: string;
  data: unknown;
  template_version_id: string | null;
}

export interface RunQueryOptions {
  /**
   * If set, restrict the query's view of `panes`, `records`, `events`, and
   * every per-collection / per-event-type view to this one pane. Resolves
   * Phase 2's view_conflict by collapsing the schema union to a single
   * template version. The pane must already be in the caller's default
   * scope; otherwise the query sees no rows (scope.pane_count = 0).
   */
  paneId?: string | null;
}

// Run an agent SQL query end-to-end. Throws QueryError on validation /
// scope / execution failures; callers should let those bubble to the
// route handler which turns them into structured 4xx responses.
export async function runQuery(
  prisma: PrismaClient,
  caller: ScopedCaller,
  rawSql: unknown,
  opts: RunQueryOptions = {},
): Promise<QueryResult> {
  const validation = validateAgentSql(rawSql);
  if (!validation.ok) {
    throw new QueryError(validation.code, validation.message, validation.hint);
  }
  const sql = validation.normalizedSql;

  const started = Date.now();
  const data = await loadScopedData(prisma, caller, { paneId: opts.paneId });

  // Spin up a fresh in-memory DuckDB. We discard it after the query, so
  // creating one per call is acceptable.
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();

  try {
    await materializeViews(conn, data, sql);
    const result = await runWithInterruptTimeout(
      conn,
      () => executeAgentSql(conn, sql),
      STATEMENT_TIMEOUT_MS,
    );
    return {
      ...result,
      scope: { kind: data.scope.kind, pane_count: data.scope.paneIds.length },
      elapsed_ms: Date.now() - started,
    };
  } finally {
    try {
      await conn.closeSync?.();
    } catch {
      // best-effort; the instance going out of scope will reap it
    }
  }
}

// DuckDB doesn't expose a Postgres-style `statement_timeout` SET parameter,
// so we enforce timeouts externally. Earlier phases used a Promise.race —
// HTTP returned quickly but the DuckDB worker thread kept running, holding
// memory + CPU. This wraps the same idea around `connection.interrupt()`
// so the worker actually unwinds when the deadline hits.
async function runWithInterruptTimeout<T>(
  conn: { interrupt: () => void },
  body: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  // Attach a swallow-handler to the body's promise so the post-interrupt
  // rejection (which DuckDB raises when we abort an in-flight query) doesn't
  // surface as an unhandledRejection. The body's own success path remains
  // unaffected.
  const bodyPromise = body().catch((err) => {
    if (timedOut) {
      // Convert into a rejection that the Promise.race below never sees,
      // because the timeoutPromise already won.
      return new Promise<T>(() => {});
    }
    throw err;
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        conn.interrupt();
      } catch {
        // Best-effort: even if interrupt fails, the timeout still rejects.
      }
      reject(
        new QueryError(
          "query_timeout",
          `query exceeded the ${timeoutMs}ms limit`,
          "narrow the query with a WHERE clause, add an aggregate, or LIMIT the result set",
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([bodyPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function loadScopedData(
  prisma: PrismaClient,
  caller: ScopedCaller,
  opts: { paneId?: string | null } = {},
): Promise<ScopedData> {
  const scope = await resolveScope(prisma, caller, { paneId: opts.paneId });
  const paneIds = scope.paneIds;

  if (paneIds.length === 0) {
    return {
      scope,
      panes: [],
      records: [],
      events: [],
      templateVersions: [],
    };
  }

  // Three parallel reads. The caller-scope was already applied via
  // pane.id IN paneIds, so these queries can never bleed across humans.
  const [panes, records, events] = await Promise.all([
    prisma.pane.findMany({
      where: { id: { in: paneIds } },
      select: {
        id: true,
        title: true,
        templateVersion: {
          select: {
            id: true,
            templateId: true,
            version: true,
            recordSchema: true,
            eventSchema: true,
          },
        },
        status: true,
        createdAt: true,
        expiresAt: true,
        deletedAt: true,
        metadata: true,
        inputData: true,
      },
    }),
    prisma.paneRecord.findMany({
      where: { collection: { paneId: { in: paneIds } } },
      take: SCOPE_RECORD_CAP + 1,
      select: {
        id: true,
        recordKey: true,
        data: true,
        version: true,
        seq: true,
        authorKind: true,
        authorId: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        collection: {
          select: { paneId: true, name: true },
        },
      },
    }),
    prisma.event.findMany({
      where: { paneId: { in: paneIds } },
      take: SCOPE_EVENT_CAP + 1,
      select: {
        id: true,
        paneId: true,
        type: true,
        ts: true,
        authorKind: true,
        authorId: true,
        data: true,
        templateVersionId: true,
      },
    }),
  ]);

  if (records.length > SCOPE_RECORD_CAP) {
    throw new QueryError(
      "scope_too_large",
      `more than ${SCOPE_RECORD_CAP} records across your panes — query API caps the live load`,
      "scope to a single pane with --pane <id>, or use pane records list per pane (paginated)",
    );
  }
  if (events.length > SCOPE_EVENT_CAP) {
    throw new QueryError(
      "scope_too_large",
      `more than ${SCOPE_EVENT_CAP} events across your panes — query API caps the live load`,
      "scope to a single pane with --pane <id>, or filter pane show --since to avoid the full event history",
    );
  }

  return {
    scope,
    panes: panes.map((p) => ({
      id: p.id,
      title: p.title,
      template_id: p.templateVersion?.templateId ?? null,
      template_version: p.templateVersion?.version ?? 0,
      status: p.status,
      created_at: p.createdAt,
      expires_at: p.expiresAt,
      deleted_at: p.deletedAt,
      metadata: p.metadata,
      input_data: p.inputData,
    })),
    records: records.map((r) => ({
      id: r.id,
      pane_id: r.collection.paneId,
      collection: r.collection.name,
      key: r.recordKey,
      data: r.data,
      version: r.version,
      seq: r.seq,
      author_kind: r.authorKind,
      author_id: r.authorId,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      deleted_at: r.deletedAt,
    })),
    events: events.map((e) => ({
      id: e.id,
      pane_id: e.paneId,
      type: e.type,
      ts: e.ts,
      author_kind: e.authorKind,
      author_id: e.authorId,
      data: e.data,
      template_version_id: e.templateVersionId,
    })),
    templateVersions: dedupTemplateVersions(panes),
  };
}

// Walk the caller's panes and collect each unique template_version's
// record_schema + event_schema. Many panes can share a version; we only
// need one copy per template_version_id to compile the per-collection
// fingerprint.
function dedupTemplateVersions(
  panes: Array<{
    templateVersion: {
      id: string;
      recordSchema: unknown;
      eventSchema: unknown;
    } | null;
  }>,
): TemplateVersionSchemas[] {
  const seen = new Set<string>();
  const out: TemplateVersionSchemas[] = [];
  for (const p of panes) {
    const v = p.templateVersion;
    if (!v) continue;
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    out.push({ recordSchema: v.recordSchema, eventSchema: v.eventSchema });
  }
  return out;
}

async function materializeViews(
  conn: {
    run: (sql: string) => Promise<unknown>;
    getTableNames: (sql: string, qualified: boolean) => readonly string[];
  },
  data: ScopedData,
  /** The user's SQL — used for lazy materialization. */
  sql: string,
): Promise<void> {
  // The data lives in DuckDB JSON columns; we build the views as if we'd
  // typed columns + a JSON `data` blob for record/event payloads. Phase 2
  // will compile per-collection views with the JSON exploded into typed
  // columns based on the record_schema.

  await conn.run(`
    CREATE TABLE _pane_raw (
      id TEXT,
      title TEXT,
      template_id TEXT,
      template_version INTEGER,
      status TEXT,
      created_at TIMESTAMP,
      expires_at TIMESTAMP,
      deleted_at TIMESTAMP,
      metadata JSON,
      input_data JSON
    )
  `);
  await conn.run(`
    CREATE TABLE _record_raw (
      id TEXT,
      pane_id TEXT,
      collection TEXT,
      key TEXT,
      data JSON,
      version INTEGER,
      seq INTEGER,
      author_kind TEXT,
      author_id TEXT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      deleted_at TIMESTAMP
    )
  `);
  await conn.run(`
    CREATE TABLE _event_raw (
      id BIGINT,
      pane_id TEXT,
      type TEXT,
      ts TIMESTAMP,
      author_kind TEXT,
      author_id TEXT,
      data JSON,
      template_version_id TEXT
    )
  `);

  await insertRows(conn, "_pane_raw", data.panes, (p) => [
    p.id,
    p.title,
    p.template_id,
    p.template_version,
    p.status,
    p.created_at,
    p.expires_at,
    p.deleted_at,
    p.metadata !== null ? JSON.stringify(p.metadata) : null,
    p.input_data !== null ? JSON.stringify(p.input_data) : null,
  ]);

  await insertRows(conn, "_record_raw", data.records, (r) => [
    r.id,
    r.pane_id,
    r.collection,
    r.key,
    JSON.stringify(r.data),
    r.version,
    r.seq,
    r.author_kind,
    r.author_id,
    r.created_at,
    r.updated_at,
    r.deleted_at,
  ]);

  await insertRows(conn, "_event_raw", data.events, (e) => [
    e.id,
    e.pane_id,
    e.type,
    e.ts,
    e.author_kind,
    e.author_id,
    e.data !== null ? JSON.stringify(e.data) : null,
    e.template_version_id,
  ]);

  // Generic views — kept for back-compat with Phase 1 and as the escape
  // hatch when a property a query needs isn't declared in the schema.
  // Always materialized: cheap, and `SHOW TABLES` needs them visible.
  await conn.run(`CREATE VIEW panes AS SELECT * FROM _pane_raw`);
  await conn.run(`CREATE VIEW records AS SELECT * FROM _record_raw`);
  await conn.run(`CREATE VIEW events AS SELECT * FROM _event_raw`);

  // Phase 2 — per-collection / per-event-type views. Compile the union of
  // schemas across every template version the caller's panes reference, then
  // emit one CREATE VIEW per unique collection name + event type. The view
  // exposes user-schema fields as typed columns (title TEXT, done BOOLEAN,
  // etc.) plus the standard `_` metadata columns. Two panes that share a
  // collection name + compatible schemas get merged into one view; a
  // type conflict raises view_conflict so the caller scopes with --pane <id>.
  //
  // Lazy materialization: only emit DDL for views the query references.
  // SHOW TABLES / DESCRIBE / EXPLAIN need the full set, so we eager-build
  // when the SQL starts with one of those keywords. Everything else passes
  // through getTableNames — DuckDB's parser tells us which tables the SQL
  // touches without executing.
  const fingerprint = buildSchemaFingerprint(data.templateVersions);
  const referenced = await referencedViewNames(conn, sql);
  const allDdls = buildViewDdl(fingerprint);
  const filteredDdls =
    referenced === "all"
      ? allDdls
      : allDdls.filter((ddl) => referencedDdlMatches(ddl, referenced));

  // Conflicts are only fatal if the user's query actually touches the
  // conflicting view. Lazy mode skips conflicts in views the query doesn't
  // reference; eager mode (introspection) reports the first conflict.
  if (fingerprint.conflicts.length > 0) {
    const fatal = fingerprint.conflicts.find((c) => {
      if (referenced === "all") return true;
      // Resolve collection name → viewName (- → _); event type → slug.
      const viewName =
        c.scope === "collection"
          ? c.name.replace(/-/g, "_")
          : c.name.replace(/[^a-zA-Z0-9_]/g, "_");
      return referenced.has(viewName);
    });
    if (fatal) {
      throw new QueryError(
        "view_conflict",
        `${fatal.scope} '${fatal.name}' has incompatible types for column '${fatal.column}' across your panes: ${fatal.seenTypes.join(", ")}`,
        "scope the query to a single pane with --pane <id> until the schema divergence is resolved (or republish the templates with a consistent column type)",
      );
    }
  }

  for (const ddl of filteredDdls) {
    await conn.run(ddl);
  }
}

// Determine which per-collection / per-event-type views the agent's SQL
// references. Returns the literal string "all" if we should eager-build
// every view (introspection queries, parser failures). Otherwise a Set of
// the unquoted view names the query touches.
async function referencedViewNames(
  conn: {
    getTableNames: (sql: string, qualified: boolean) => readonly string[];
  },
  sql: string,
): Promise<"all" | Set<string>> {
  const trimmed = sql.trim().toLowerCase();
  // Introspection queries need every view visible — SHOW TABLES enumerates
  // them, DESCRIBE / EXPLAIN need targets to exist. Be conservative.
  if (
    trimmed.startsWith("show") ||
    trimmed.startsWith("describe") ||
    trimmed.startsWith("desc ") ||
    trimmed.startsWith("explain") ||
    trimmed.startsWith("pragma")
  ) {
    return "all";
  }
  try {
    const names = conn.getTableNames(sql, false);
    return new Set(names);
  } catch {
    // Parser failed (unusual — DuckDB's parser is forgiving). Fall back to
    // eager materialization so the agent still gets a useful error from
    // the real execution.
    return "all";
  }
}

// `buildViewDdl` emits the CREATE VIEW string for each materialized view;
// the view name appears as `CREATE VIEW "<name>" AS …`. Extract it so we
// can match the lazy-materialization set against the DDL list.
function referencedDdlMatches(ddl: string, referenced: Set<string>): boolean {
  const match = ddl.match(/CREATE VIEW\s+"([^"]+)"/);
  if (!match) return true; // unknown DDL shape → emit it (safe fallback)
  return referenced.has(match[1]!);
}

// Batch INSERT helper. DuckDB's VALUES clause is fine for the row counts
// we expect in Phase 1 (caps at 200k per table). Phase 3 should swap this
// for the Appender API if cold-start latency becomes a concern.
async function insertRows<T>(
  conn: { run: (sql: string) => Promise<unknown> },
  table: string,
  rows: T[],
  toValues: (row: T) => unknown[],
): Promise<void> {
  if (rows.length === 0) return;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const valuesSql = slice
      .map((row) => `(${toValues(row).map(formatLiteral).join(",")})`)
      .join(",\n");
    await conn.run(`INSERT INTO ${table} VALUES ${valuesSql}`);
  }
}

function formatLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) {
    // DuckDB accepts ISO-8601 strings cast implicitly to TIMESTAMP.
    return `TIMESTAMP '${v.toISOString().replace("T", " ").replace("Z", "")}'`;
  }
  // strings + serialized JSON — escape single quotes
  const s = String(v).replace(/'/g, "''");
  return `'${s}'`;
}

async function executeAgentSql(
  conn: {
    runAndReadAll: (sql: string) => Promise<{
      columnNames: () => string[];
      getRows: () => unknown[][];
    }>;
  },
  sql: string,
): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
  let reader: { columnNames: () => string[]; getRows: () => unknown[][] };
  try {
    reader = await conn.runAndReadAll(sql);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // DuckDB statement timeout surfaces as a TimeoutError or a "query was
    // interrupted" message; normalise to query_timeout.
    if (/timeout|interrupted/i.test(detail)) {
      throw new QueryError(
        "query_timeout",
        `query exceeded the ${STATEMENT_TIMEOUT_MS}ms limit`,
        "narrow the query with a WHERE clause, add an aggregate, or LIMIT the result set",
      );
    }
    throw new QueryError(
      "query_error",
      detail,
      "check the SQL for typos, unsupported syntax, or references to tables you don't have access to",
    );
  }

  const columns = reader.columnNames();
  const rawRows = reader.getRows();

  // DuckDB returns BigInt for INTEGER/BIGINT columns; coerce to Number
  // when safe, otherwise stringify. Same for Date — return ISO-8601.
  const rows = rawRows
    .slice(0, OUTPUT_ROW_CAP)
    .map((row) => row.map((cell) => normalizeCell(cell)));

  return {
    columns,
    rows,
    truncated: rawRows.length > OUTPUT_ROW_CAP,
  };
}

function normalizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") {
    // BigInt is JSON.stringify-unfriendly; downcast when safe, otherwise
    // return as a string so the consumer can parse if they care about precision.
    if (
      v >= BigInt(Number.MIN_SAFE_INTEGER) &&
      v <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return Number(v);
    }
    return v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && v !== null) {
    // DuckDB returns nested objects for STRUCT/MAP/LIST; pass through —
    // the route serializer turns these into JSON.
    return v;
  }
  return v;
}
