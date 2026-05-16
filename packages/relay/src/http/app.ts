import { Hono } from "hono";
import { ZodError } from "zod";
import config from "../config.js";
import { ApiError } from "./errors.js";
import { log } from "../log.js";
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
        log.info("req", { reqId, method: c.req.method, path, status: c.res.status, ms });
      }
    }
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        err.status as 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 500,
      );
    }
    if (err instanceof ZodError) {
      return c.json(
        { error: { code: "invalid_request", message: "invalid body", details: err.flatten() } },
        400,
      );
    }
    log.error("internal", { error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: { code: "internal" } }, 500);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // /v1/register is conditionally mounted; off when REGISTRATION_SECRET is unset.
  if (config.REGISTRATION_SECRET) {
    app.route("/v1/register", register);
  }
  app.route("/v1/sessions", sessions);
  app.route("/v1/sessions/:id/events", events);
  app.route("/v1/keys", keys);
  app.route("/s", bridge);

  return app;
}
