// `pane query` — read-only SQL over the calling agent's scoped data (#355).
//
// The whole feature lives on the relay (POST /v1/query). The CLI is a thin
// shell over @paneui/core's `client.query(sql)`:
//   1. Read the SQL from args (positional), stdin, or --file.
//   2. Send it to the relay.
//   3. Format the result for human or pipe (json | csv | tsv | table),
//      auto-detecting TTY when --format isn't passed.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { readFileSync } from "node:fs";
import type { QueryResponse } from "@paneui/core";

const KNOWN_FLAGS = new Set(["file", "format", "url", "api-key"]);
const KNOWN_BOOLS = new Set(["help"]);

const VALID_FORMATS = new Set(["json", "csv", "tsv", "table"]);

export const queryHelp = `pane query — run read-only SQL over your scoped data (#355)

Available tables (all rows already scoped to panes you own):

  panes     id, title, template_id, template_version, status,
            created_at, expires_at, deleted_at, metadata, input_data
  records   id, pane_id, collection, key, data, version, seq,
            author_kind, author_id, created_at, updated_at, deleted_at
  events    id, pane_id, type, ts, author_kind, author_id, data,
            template_version_id

\`data\` is a JSON column — project with Postgres-style operators:
  data->>'title'                  text
  (data->>'done')::boolean        cast
  data->'nested'->>'inner_field'  deep

Usage:
  pane query "<SQL>"                    SQL as positional argument
  pane query --file ./report.sql        read from a file
  echo "SELECT ..." | pane query        read from stdin

Options:
  --file <path>       read SQL from a file instead of an argument / stdin
  --format <fmt>      json | csv | tsv | table  (default: table for TTYs,
                      json otherwise)
  --url <url>         relay base URL  (overrides PANE_URL)
  --api-key <key>     agent API key   (overrides PANE_API_KEY)
  -h, --help          show this help

Limits:
  - Result is capped at 10,000 rows (response.truncated = true if hit).
  - Statement timeout: 10 seconds.
  - SQL: SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / PRAGMA only.

Examples:
  pane query "SELECT title FROM panes ORDER BY created_at DESC LIMIT 10"
  pane query "SELECT type, COUNT(*) AS n FROM events GROUP BY 1 ORDER BY n DESC"
  pane query "SELECT data->>'title' AS title, version
              FROM records WHERE collection = 'todos' AND deleted_at IS NULL"
`;

export async function runQuery(args: ParsedArgs): Promise<void> {
  if (args.bools.has("help")) {
    process.stdout.write(queryHelp + "\n");
    return;
  }
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane query");

  // Decide format. Default depends on TTY-ness of stdout so piping is
  // never broken by accidentally getting a column-aligned table.
  let format = args.flags.get("format");
  if (format === undefined || format === "") {
    format = process.stdout.isTTY ? "table" : "json";
  }
  if (!VALID_FORMATS.has(format)) {
    fail(
      `--format must be one of ${[...VALID_FORMATS].join("|")} (got '${format}')`,
      "invalid_args",
    );
  }

  // Source the SQL: --file > positional > stdin (in that order).
  let sql: string | null = null;
  const file = args.flags.get("file");
  if (file !== undefined && file !== "") {
    try {
      sql = readFileSync(file, "utf8");
    } catch (e) {
      fail(
        `--file '${file}' could not be read: ${(e as Error).message}`,
        "invalid_args",
      );
    }
  } else if (args.positionals.length > 0) {
    sql = args.positionals.join(" ");
  } else if (!process.stdin.isTTY) {
    sql = await readAllStdin();
  }
  if (sql == null || sql.trim().length === 0) {
    fail(
      "missing SQL — pass it as the positional argument, --file <path>, or pipe it to stdin",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  let result: QueryResponse;
  try {
    result = await client.query(sql);
  } catch (e) {
    failFromError(e);
    return; // unreachable; failFromError exits
  }

  switch (format) {
    case "json":
      printJson(result);
      break;
    case "csv":
      writeDelimited(result, ",");
      break;
    case "tsv":
      writeDelimited(result, "\t");
      break;
    case "table":
      writeTable(result);
      break;
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// --------------------------------------------------------------------------
// Formatters
// --------------------------------------------------------------------------

function writeDelimited(result: QueryResponse, sep: string): void {
  process.stdout.write(
    result.columns.map((c: string) => escapeDelimited(sep, c)).join(sep) + "\n",
  );
  for (const row of result.rows) {
    process.stdout.write(
      row
        .map((c: unknown) => escapeDelimited(sep, formatCellForText(c)))
        .join(sep) + "\n",
    );
  }
  if (result.truncated) {
    process.stderr.write(
      `[truncated: result capped at ${result.rows.length} rows]\n`,
    );
  }
}

function escapeDelimited(sep: string, value: string): string {
  // RFC-4180-ish: quote when the cell contains the delimiter, a quote, or a newline.
  if (
    value.includes(sep) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function writeTable(result: QueryResponse): void {
  if (result.columns.length === 0) {
    process.stdout.write("(no columns)\n");
    return;
  }
  const cells: string[][] = [];
  cells.push(result.columns.slice());
  for (const row of result.rows) {
    cells.push(row.map((c: unknown) => formatCellForText(c)));
  }
  // Compute column widths (cap at 80 to keep the table sane for wide JSON).
  const COL_MAX = 80;
  const widths = result.columns.map((_: string, ci: number) =>
    Math.min(
      COL_MAX,
      Math.max(...cells.map((r: string[]) => visualWidth(r[ci] ?? ""))),
    ),
  );
  const rule = "─".repeat(
    widths.reduce((a: number, b: number) => a + b, 0) + (widths.length - 1) * 3,
  );
  // Header
  process.stdout.write(formatRow(cells[0]!, widths) + "\n");
  process.stdout.write(rule + "\n");
  for (let i = 1; i < cells.length; i++) {
    process.stdout.write(formatRow(cells[i]!, widths) + "\n");
  }
  process.stderr.write(
    `\n${result.rows.length} row${result.rows.length === 1 ? "" : "s"}${
      result.truncated ? " (truncated; cap = 10000)" : ""
    } · scope: ${result.scope.kind} (${result.scope.pane_count} panes) · ${result.elapsed_ms}ms\n`,
  );
}

function formatRow(cells: string[], widths: number[]): string {
  return cells
    .map((c, i) => truncate(c, widths[i] ?? 0).padEnd(widths[i] ?? 0))
    .join(" │ ");
}

function truncate(s: string, w: number): string {
  if (visualWidth(s) <= w) return s;
  return s.slice(0, Math.max(0, w - 1)) + "…";
}

function visualWidth(s: string): number {
  // Strip ANSI / treat as raw text — agents won't be styling SQL output.
  return s.length;
}

function formatCellForText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return v.toString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
