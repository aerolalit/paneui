// POST /v1/query — agent-facing SQL query endpoint.
//
// Issue #355. See packages/relay/src/query/engine.ts for the mechanics:
// per-request DuckDB instance loaded with the caller's scoped data, agent's
// SQL run against three views (panes, records, events), result capped + timed.
//
// Phase 1 ships the three raw views. Phase 2 adds per-collection / per-event-
// type materialized views so the agent writes `SELECT title FROM todos`
// instead of `SELECT data->>'title' FROM records WHERE collection='todos'`.

import { Hono } from "hono";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import { runQuery, QueryError } from "../../query/engine.js";

const query = new Hono<AuthEnv>();
query.use("*", requireAgent);

query.post("/", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");

  const body = (await c.req.json().catch(() => null)) as {
    sql?: unknown;
    pane_id?: unknown;
  } | null;
  if (body === null || typeof body !== "object") {
    throw errors.invalidRequest(
      "request body must be a JSON object",
      undefined,
      'pass the query as { "sql": "SELECT ...", "pane_id": "pan_..." }',
    );
  }

  // Optional pane_id scopes the query to a single pane — resolves the
  // Phase 2 view_conflict case where two panes' schemas disagree.
  let paneId: string | null = null;
  if (body.pane_id !== undefined && body.pane_id !== null) {
    if (typeof body.pane_id !== "string" || !body.pane_id.startsWith("pan_")) {
      throw errors.invalidRequest(
        "pane_id must be a pane id string (starts with 'pan_')",
        undefined,
        'pass { "sql": "...", "pane_id": "pan_xxx" } to scope to one pane',
      );
    }
    paneId = body.pane_id;
  }

  try {
    const result = await runQuery(
      prisma,
      { agentId: agent.id, ownerHumanId: agent.ownerHumanId ?? null },
      body.sql,
      { paneId },
    );
    return c.json(result, 200);
  } catch (err) {
    if (err instanceof QueryError) {
      // Map to the standard error envelope. Use 400 for caller-side problems
      // (bad SQL, scope_too_large) and 422 for execution failures (timeout,
      // DuckDB raised a parser/eval error).
      const status =
        err.code === "query_timeout" || err.code === "query_error" ? 422 : 400;
      // Throwing a structured error here would route through app.onError;
      // for clarity, build the envelope inline. Keep the shape consistent
      // with the rest of /v1.
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            hint: err.hint,
            retryable: err.code === "query_timeout" ? false : false,
            docs_url:
              "https://github.com/aerolalit/paneui/blob/main/docs/SPEC.md#http-api-v1",
          },
        },
        status,
      );
    }
    throw err;
  }
});

export default query;
