import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import type { AttachmentStore, RevokeCache } from "../attachments/index.js";
import { makeRevokeCache } from "../attachments/index.js";
import type { EmailProvider } from "../auth/email-provider.js";
import { makeNoneProvider } from "../auth/providers/none.js";
import { ApiError, errors as apiErrors, serializeApiError } from "./errors.js";
import type { AppEnv } from "./env.js";
import { createRateLimiter, type SlidingWindowLimiter } from "./rate-limit.js";
import { log } from "../log.js";
import { recordError, recordHttpDuration } from "../telemetry/metrics.js";
import { recordExceptionOnActiveSpan } from "../telemetry/tracing.js";
import register from "./routes/register.js";
import surfaces from "./routes/surfaces.js";
import templates from "./routes/templates.js";
import { auth } from "./routes/auth.js";
import self from "./routes/self.js";
import agents from "./routes/agents.js";
import participantsHuman from "./routes/participants-human.js";
import {
  templatePublish,
  templateMarketplace,
} from "./routes/template-marketplace.js";
import systemPages from "./routes/system-pages.js";
import ownerShell from "./routes/owner-shell.js";
import events from "./routes/events.js";
import keys from "./routes/keys.js";
import taste from "./routes/taste.js";
import feedback from "./routes/feedback.js";
import attachments from "./routes/attachments.js";
import blobBridge from "../bridge/attachment-bridge.js";
import blobUploadBridge from "../bridge/attachment-upload-bridge.js";
import blobDownloadBridge from "../bridge/attachment-download-bridge.js";
import skill from "./routes/skill.js";
import bridge from "../bridge/routes.js";
import { generalRateLimit } from "./rate-limit.js";
import { cliVersionMiddleware } from "./cli-version.js";

// Build the Hono app with its dependencies injected. `config` and `prisma` are
// placed on the request context by the first middleware so every route and
// middleware reads them via `c.get(...)` instead of importing singletons.
//
// `generalLimiter` is the per-IP + per-token limiter for /v1/* and /s/* routes.
// The relay (index.ts) constructs it once and passes the SAME instance to both
// buildApp() and attachWs(), so HTTP requests and WebSocket-upgrade attempts
// share one IP bucket. It is optional purely for tests that only exercise the
// HTTP app: when omitted, buildApp() creates its own from config.
export function buildApp(
  config: Config,
  prisma: PrismaClient,
  generalLimiter?: SlidingWindowLimiter,
  blobStore?: AttachmentStore,
  blobRevokeCache?: RevokeCache,
  emailProvider?: EmailProvider,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // One per-app limiter for the open /v1/register endpoint. Created here (not
  // at module load) so its sliding-window state is owned by this app instance.
  const registerLimiter = createRateLimiter(
    config.REGISTER_RATE_LIMIT,
    config.REGISTER_RATE_WINDOW_SECONDS * 1000,
  );

  // Fall back to an app-owned general limiter when the caller did not inject a
  // shared one (HTTP-only tests). The relay always injects the shared instance.
  const effectiveGeneralLimiter =
    generalLimiter ??
    createRateLimiter(
      config.RATE_LIMIT,
      config.RATE_LIMIT_WINDOW_SECONDS * 1000,
    );

  // AttachmentStore + RevokeCache come as a pair: if a blobStore is configured,
  // the cache exists (caller-supplied for tests, or auto-instantiated here
  // for the HTTP-only convenience path).
  const effectiveBlobRevokeCache =
    blobRevokeCache ?? (blobStore ? makeRevokeCache() : undefined);

  // EmailProvider falls back to the `none` provider when the caller (HTTP-only
  // tests / lightweight harnesses) doesn't inject one. The relay always injects
  // its provider via makeEmailProvider().
  const effectiveEmailProvider = emailProvider ?? makeNoneProvider();

  app.use("*", async (c, next) => {
    c.set("config", config);
    c.set("prisma", prisma);
    c.set("registerLimiter", registerLimiter);
    c.set("generalLimiter", effectiveGeneralLimiter);
    if (blobStore) c.set("blobStore", blobStore);
    if (effectiveBlobRevokeCache)
      c.set("blobRevokeCache", effectiveBlobRevokeCache);
    c.set("emailProvider", effectiveEmailProvider);
    await next();
  });

  app.use("*", async (c, next) => {
    const start = Date.now();
    const reqId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.header("X-Request-Id", reqId);
    try {
      await next();
    } finally {
      const ms = Date.now() - start;
      // Redact the surface token in /s/<tok>/... bridge paths AND the attachment
      // capability token in /b/<tok> paths — both are bearer secrets in the
      // URL itself and must never reach access logs / log aggregators in
      // unredacted form.
      const path = c.req.path
        .replace(/^\/s\/[^/]+/, "/s/***")
        .replace(/^\/b\/[^/]+/, "/b/***");
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
      // /v1/surfaces/:id/events) — never the concrete path — to keep the
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
      // Log auth/cap/expiry rejections at info so operators can see who got
      // turned away (the `req` middleware logs the status, but not the `code`
      // — without this line, a wave of 401/404s is indistinguishable from
      // normal traffic). Token-bearing URLs (/s/:token, /b/:token) are
      // redacted with the same rules as the req-log middleware above.
      log.info("api rejected", {
        reqId: c.res.headers.get("X-Request-Id") ?? undefined,
        code: err.code,
        status: err.status,
        method: c.req.method,
        path: c.req.path
          .replace(/^\/s\/[^/]+/, "/s/***")
          .replace(/^\/b\/[^/]+/, "/b/***"),
      });
      // Additive, agent-friendly error envelope. `code`/`message`/`details`
      // are unchanged for existing clients; `hint`/`retryable`/`docs_url`
      // (snake_case on the wire) are appended and omitted when undefined.
      return c.json(
        { error: serializeApiError(err) },
        err.status as
          | 400
          | 401
          | 403
          | 404
          | 409
          | 410
          | 413
          | 415
          | 422
          | 426
          | 429
          | 500
          | 501,
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

  // GET / is served by systemPages (below) — a public landing page for
  // logged-out callers and a redirect to /home for logged-in humans.
  // Earlier this route 302'd to https://paneui.com, which meant the relay
  // had no public face of its own; the operator's marketing site swallowed
  // every unauthenticated visit. The landing now belongs to systemPages so
  // logged-in nav, branding, and theming stay consistent.

  // GET /skills/pane/SKILL.md — the pane agent skill, served verbatim so an
  // agent can fetch it from the relay it uses. Registered here, before the
  // rate-limit middleware, so it stays unmetered like /healthz.
  app.route("/skills", skill);

  // System pages — /login + /home + /my-surfaces + /my-templates + /my-agents
  // + /settings. These are pane-shipped HTML pages that read the human's
  // Login cookie and render their data. Registered before the rate limiter
  // (like /skills and /healthz) so a hostile bot can't lock a legitimate
  // human out of the login page itself.
  app.route("/", systemPages);

  // Global request-body size cap. Routes parse JSON bodies with c.req.json();
  // the per-payload caps (MAX_ARTIFACT_BYTES, MAX_EVENT_DATA_BYTES,
  // MAX_BLOB_BYTES) are only checked AFTER a full parse, so without this an
  // oversized body is buffered and JSON.parse'd in memory before being
  // rejected — a trivial OOM DoS. This ceiling sits a little above the
  // largest legitimate body (max of templates and attachment uploads) to leave room
  // for JSON envelope / multipart boundary overhead. The tighter /events
  // limit is applied on that route below.
  const globalBodyLimit =
    Math.max(config.MAX_ARTIFACT_BYTES, config.MAX_BLOB_BYTES) + 256 * 1024;
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: globalBodyLimit,
      onError: () => {
        throw apiErrors.payloadTooLarge();
      },
    }),
  );
  // The participant-side attachment upload (POST /s/:token/attachments, follow-up C of #156)
  // is the only /s/* route that accepts a body large enough to need the cap.
  // Reuse the same ceiling so the human-side upload path is no more permissive
  // than the agent's `POST /v1/attachments`.
  app.use(
    "/s/*/attachments",
    bodyLimit({
      maxSize: globalBodyLimit,
      onError: () => {
        throw apiErrors.payloadTooLarge();
      },
    }),
  );

  // General per-IP + per-token rate limit on every API/bridge route. /healthz
  // and /skills are registered above so they stay unmetered (load balancers
  // poll them). The rate-limit middleware runs after the request-id/duration
  // middleware (app.use("*", ...) above) so rejected (429) requests are still
  // logged and traced. The open /v1/register endpoint additionally has its own
  // stricter per-IP limiter applied inside the route module.
  app.use("/v1/*", generalRateLimit);
  app.use("/s/*", generalRateLimit);
  // /surfaces/:id/* — the cookie-authed owner shell. Same per-IP + per-token
  // limiter as /s/* so an attacker who steals a session cookie can't grind
  // through endpoints any faster than they could with a participant token.
  app.use("/surfaces/*", generalRateLimit);

  // CLI-version skew check on the agent-facing API. Runs after the rate
  // limiter so a hostile too-old CLI also pays the per-IP cost; runs before
  // the routes so the 426 lands before any expensive work. Bridge routes
  // (/s/*) are human-facing and have no CLI version to check; the skill +
  // health routes are mounted above and stay unmetered.
  app.use("/v1/*", cliVersionMiddleware(config));

  // Owner-shell mount — /surfaces/:id + nested content/presence/ws-ticket.
  // Cookie-authed, owner-only: renders the same shell + iframe runtime as the
  // capability-token /s/:token mount but with surface-id-keyed callback URLs,
  // so a logged-in human opens their own surfaces without a token in the URL.
  // Registered AFTER the rate-limit + body-cap middleware (unlike systemPages,
  // which deliberately stays unmetered so a bot can't lock a human out of
  // /login) so an attacker hammering /surfaces/* hits the per-IP limiter
  // just like they would on /s/*.
  app.route("/surfaces", ownerShell);

  // /v1/register is gated by REGISTRATION_MODE (config.ts), enforced inside
  // the route module: `closed` (default) returns 404; `secret` requires an
  // `Authorization: Bearer <REGISTRATION_SECRET>` token; `open` is public.
  // In the secret and open modes a per-IP rate limit bounds abuse.
  app.route("/v1/register", register);
  // /v1/auth/* — human-side magic-link login. The route module handles the
  // EMAIL_PROVIDER=none case internally (returns 503 auth_provider_unavailable)
  // so unconfigured self-hosters get a clear signal instead of a 404.
  app.route("/v1", auth);
  app.route("/v1/surfaces", surfaces);
  // Event bodies carry at most MAX_EVENT_DATA_BYTES of `data`; a tighter cap
  // here (leaving headroom for the JSON envelope) rejects an oversized event
  // body before it is buffered/parsed, ahead of the global /v1/* limit.
  app.use(
    "/v1/surfaces/:id/events",
    bodyLimit({
      maxSize: config.MAX_EVENT_DATA_BYTES + 64 * 1024,
      onError: () => {
        throw apiErrors.payloadTooLarge();
      },
    }),
  );
  app.route("/v1/surfaces/:id/events", events);
  // Phase F — public catalog + install flow. MUST mount the human-side
  // marketplace BEFORE the agent-CRUD `templates` router: the latter has
  // a `/:id` route that would otherwise capture `/public` (`id=public`)
  // and apply requireAgent middleware, 401-ing the human caller.
  app.route("/v1/templates", templateMarketplace);
  app.route("/v1/templates", templatePublish);
  app.route("/v1/templates", templates);
  app.route("/v1/keys", keys);
  // /v1/self/* — human-authenticated routes about the calling human's
  // own account. Currently only the claim-code mint; Phase D extends it.
  app.route("/v1/self", self);
  // /v1/agents/* — agent-authenticated routes about the calling agent.
  // Currently only the claim endpoint; Phase D will likely add more.
  app.route("/v1/agents", agents);
  // /v1/surfaces/:id/identity-link + /v1/surfaces/:id/public-link — Phase E.
  // Human-authenticated mints; the agent-authed POST /v1/surfaces/:id/participants
  // is unchanged and lives in routes/surfaces.ts.
  app.route("/v1/surfaces", participantsHuman);
  app.route("/v1/taste", taste);
  app.route("/v1/feedback", feedback);
  app.route("/v1/attachments", attachments);
  // POST /s/:participantToken/attachments — human-side attachment upload (follow-up C
  // of #156). Mounted BEFORE the general /s bridge so the POST route is
  // matched cleanly; the bridge module only registers GET endpoints, but
  // routing order keeps the surfaces visibly separate.
  app.route("/s", blobUploadBridge);
  // GET /s/:participantToken/attachments/:attachment_id — human-side attachment download
  // (follow-up D of #156). The symmetric counterpart to the upload bridge:
  // the iframe lazy-fetches attachment bytes referenced by events through the
  // shell so events can carry just a AttachmentRef instead of inlined base64.
  app.route("/s", blobDownloadBridge);
  app.route("/s", bridge);
  // /b/<token> — capability-URL fetch path for attachment bytes. The URL token IS
  // the credential (no API key, no participant token), so the route module
  // does its own validation; no agent-auth middleware here.
  app.route("/b", blobBridge);

  return app;
}
