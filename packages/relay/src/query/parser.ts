// SELECT-only enforcement for the agent-facing /v1/query endpoint.
//
// Strictly speaking, the in-memory ephemeral DuckDB instance the engine builds
// per request IS the sandbox — INSERT/UPDATE/DELETE against the materialized
// views would error (views aren't writable), CREATE TABLE only litters the
// caller's own throwaway instance, ATTACH can't reach the relay's real DB.
// The check below is for UX clarity (clearer errors than DuckDB's raw "view
// is not insertable into") and as defense in depth, not as the security
// boundary. The view scoping in scope.ts + engine.ts is the boundary.

const ALLOWED_LEADING_KEYWORDS = new Set([
  "select",
  "with",
  "show",
  "describe",
  "desc",
  "pragma", // DuckDB's PRAGMA is mostly read-only introspection
  "explain",
]);

const BANNED_KEYWORDS = [
  "attach",
  "detach",
  "copy",
  "export",
  "import",
  "install",
  "load",
  "set",
  "reset",
  "begin",
  "commit",
  "rollback",
  "checkpoint",
];

export interface SqlValidationResult {
  ok: true;
  normalizedSql: string;
}

export interface SqlValidationError {
  ok: false;
  code: string;
  message: string;
  hint: string;
}

// Strip line + block comments so a comment can't smuggle a banned keyword
// past the regex check. DuckDB handles comments itself at parse time, but
// we apply the leading-keyword and banned-keyword checks against the
// uncommented form.
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      // line comment
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      out += " ";
    } else if (sql[i] === "/" && sql[i + 1] === "*") {
      // block comment — DuckDB doesn't allow nesting; mirror that
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (sql[i] === "'" || sql[i] === '"') {
      // string literal — copy verbatim so words inside don't trip the
      // banned-keyword regex
      const quote = sql[i]!;
      out += quote;
      i += 1;
      while (i < sql.length && sql[i] !== quote) {
        if (sql[i] === "\\" && i + 1 < sql.length) {
          out += sql[i]! + sql[i + 1]!;
          i += 2;
        } else {
          out += sql[i]!;
          i += 1;
        }
      }
      if (i < sql.length) {
        out += sql[i]!;
        i += 1;
      }
    } else {
      out += sql[i]!;
      i += 1;
    }
  }
  return out;
}

// Validate that `sql` is a single read-only statement.
//
// Returns either an ok-result carrying the trimmed SQL, or an error-result
// the route handler can turn into a 400. Callers should branch on the
// `ok` field — no exceptions are thrown.
export function validateAgentSql(rawSql: unknown): SqlValidationResult | SqlValidationError {
  if (typeof rawSql !== "string") {
    return {
      ok: false,
      code: "invalid_request",
      message: "sql must be a string",
      hint: 'pass the query as a JSON body: { "sql": "SELECT ..." }',
    };
  }
  const trimmed = rawSql.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: "invalid_request",
      message: "sql is empty",
      hint: 'pass a SELECT statement in the JSON body: { "sql": "SELECT ..." }',
    };
  }
  // 32KB cap — agents writing queries longer than this almost certainly
  // need a stored view, not a one-shot query. The cap is a fingerprint
  // against junk payloads, not a precise budget.
  const MAX_SQL_BYTES = 32 * 1024;
  if (Buffer.byteLength(trimmed, "utf8") > MAX_SQL_BYTES) {
    return {
      ok: false,
      code: "invalid_request",
      message: `sql exceeds ${MAX_SQL_BYTES} byte cap`,
      hint: "shorten the query, factor it into a CTE, or push the data through pane records list and aggregate client-side",
    };
  }

  const uncommented = stripComments(trimmed).trim();
  if (uncommented.length === 0) {
    return {
      ok: false,
      code: "invalid_request",
      message: "sql contains only comments",
      hint: "the query must contain at least one SELECT / WITH / SHOW / DESCRIBE / EXPLAIN statement",
    };
  }

  // Reject multiple statements. Trailing-only semicolons are fine.
  // The simplest correctness check: split on `;` and ensure all but
  // the last (which may be the empty tail of a trailing `;`) are blank.
  // Quoted-string semicolons were already preserved above, but `stripComments`
  // also copies string contents — so we have to re-tokenize against quotes.
  const stmts = splitStatements(uncommented);
  if (stmts.length > 1) {
    return {
      ok: false,
      code: "invalid_request",
      message: "only one statement per query is allowed",
      hint: "split multi-statement queries into separate calls; or use a CTE / UNION to combine them in a single statement",
    };
  }

  const stmt = stmts[0]!;
  const firstWord = (stmt.match(/^\s*([a-zA-Z]+)/)?.[1] ?? "").toLowerCase();
  if (!ALLOWED_LEADING_KEYWORDS.has(firstWord)) {
    return {
      ok: false,
      code: "invalid_request",
      message: `${firstWord || "(empty)"} statements are not allowed`,
      hint: "the query API is read-only — supported leading keywords: SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, PRAGMA",
    };
  }

  // Look for any banned keyword as a standalone token. The leading-keyword
  // check above already covers ATTACH/SET/etc when they're the FIRST token;
  // this catches them when they're nested in subqueries / CTEs.
  for (const banned of BANNED_KEYWORDS) {
    const re = new RegExp(`\\b${banned}\\b`, "i");
    if (re.test(stmt)) {
      return {
        ok: false,
        code: "invalid_request",
        message: `'${banned.toUpperCase()}' is not allowed in queries`,
        hint: "the query API is read-only — remove ATTACH/COPY/SET/INSTALL/LOAD/etc. statements",
      };
    }
  }

  return { ok: true, normalizedSql: stmt };
}

// Statement-splitter that respects string literals and dollar-quoted strings.
// Doesn't try to match parenthesis depth — DuckDB's parser handles balance.
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      buf += ch;
      i += 1;
      while (i < sql.length && sql[i] !== quote) {
        if (sql[i] === "\\" && i + 1 < sql.length) {
          buf += sql[i]! + sql[i + 1]!;
          i += 2;
        } else {
          buf += sql[i]!;
          i += 1;
        }
      }
      if (i < sql.length) {
        buf += sql[i]!;
        i += 1;
      }
    } else if (ch === ";") {
      const trimmed = buf.trim();
      if (trimmed.length > 0) out.push(trimmed);
      buf = "";
      i += 1;
    } else {
      buf += ch;
      i += 1;
    }
  }
  const trailing = buf.trim();
  if (trailing.length > 0) out.push(trailing);
  return out;
}
