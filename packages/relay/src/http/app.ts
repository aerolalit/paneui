import { Hono } from "hono";
import { ZodError } from "zod";
import config from "../config.js";
import { ApiError, serializeApiError } from "./errors.js";
import { log } from "../log.js";
import {
  collectPrometheusMetrics,
  metricsEnabled,
  recordError,
  recordHttpDuration,
} from "../telemetry/metrics.js";
import { recordExceptionOnActiveSpan } from "../telemetry/tracing.js";
import register from "./routes/register.js";
import sessions from "./routes/sessions.js";
import events from "./routes/events.js";
import keys from "./routes/keys.js";
import bridge from "../bridge/routes.js";

export function buildApp(): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const start = Date.now();
    const reqId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.header("X-Request-Id", reqId);
    try {
      await next();
    } finally {
      const ms = Date.now() - start;
      // Redact the session token in /s/<tok>/... paths if/when phase 3 adds them.
      const path = c.req.path.replace(/^\/s\/[^/]+/, "/s/***");
      if (path !== "/healthz") {
        log.info("req", {
          reqId,
          method: c.req.method,
          path,
          status: c.res.status,
          ms,
        });
      }
      // Record request duration against the matched ROUTE PATTERN (e.g.
      // /v1/sessions/:id/events) — never the concrete path — to keep the
      // histogram's label cardinality bounded. No-op when metrics are disabled.
      recordHttpDuration(ms / 1000, {
        method: c.req.method,
        route: c.req.routePath || path,
        status: c.res.status,
      });
    }
  });

  app.onError((err, c) => {
    // Enrich the active HTTP span (created by the OTel HTTP instrumentation)
    // with the exception so Application Insights surfaces it as an exception
    // on the request trace. No-op when no span is active (e.g. prometheus
    // mode, or a 4xx ApiError which is still a legitimate "error" to record).
    recordExceptionOnActiveSpan(err);
    if (err instanceof ApiError) {
      // Count the error exactly once, here, by its low-cardinality `code`.
      recordError(err.code);
      // Additive, agent-friendly error envelope. `code`/`message`/`details`
      // are unchanged for existing clients; `hint`/`retryable`/`docs_url`
      // (snake_case on the wire) are appended and omitted when undefined.
      return c.json(
        { error: serializeApiError(err) },
        err.status as 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500,
      );
    }
    if (err instanceof ZodError) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "invalid body",
            hint: "the request body failed validation; see details for the failing fields",
            retryable: false,
            details: err.flatten(),
          },
        },
        400,
      );
    }
    log.error("internal", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: { code: "internal" } }, 500);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // GET /metrics — Prometheus text exposition. Mounted ONLY when metrics are
  // enabled AND the exporter is prometheus. Served on the existing Hono app
  // (one port, simpler deploy) rather than the OTel exporter's own server.
  // No auth: standard for a Prometheus scrape target — operators should
  // firewall it off if the relay is publicly reachable.
  if (config.METRICS_ENABLED && config.METRICS_EXPORTER === "prometheus") {
    app.get("/metrics", async (c) => {
      if (!metricsEnabled()) {
        return c.json({ error: { code: "not_found" } }, 404);
      }
      const body = await collectPrometheusMetrics();
      if (body === null) {
        return c.json({ error: { code: "not_found" } }, 404);
      }
      return c.body(body, 200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      });
    });
  }

  // /v1/register is open (no secret); abuse is bounded by a per-IP rate limit
  // applied inside the route module.
  app.route("/v1/register", register);
  app.route("/v1/sessions", sessions);
  app.route("/v1/sessions/:id/events", events);
  app.route("/v1/keys", keys);
  app.route("/s", bridge);

  return app;
}
