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

  const body = (await c.req.json().catch(() => null)) as { sql?: unknown } | null;
  if (body === null || typeof body !== "object") {
    throw errors.invalidRequest(
      "request body must be a JSON object",
      undefined,
      'pass the query as { "sql": "SELECT ..." }',
    );
  }

  try {
    const result = await runQuery(
      prisma,
      { agentId: agent.id, ownerHumanId: agent.ownerHumanId ?? null },
      body.sql,
    );
    return c.json(result, 200);
  } catch (err) {
    if (err instanceof QueryError) {
      // Map to the standard error envelope. Use 400 for caller-side problems
      // (bad SQL, scope_too_large) and 422 for execution failures (timeout,
      // DuckDB raised a parser/eval error).
      const status = err.code === "query_timeout" || err.code === "query_error" ? 422 : 400;
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
