// IMPORTANT: telemetry/bootstrap MUST be the first import. It registers the
// HTTP auto-instrumentation, which monkey-patches Node's `http` module — that
// patch must be installed before `@hono/node-server` (below) loads `http`.
import "./telemetry/bootstrap.js";
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { serve } from "@hono/node-server";
import {
  loadConfigOrExit,
  redactConfig,
  validateProductionConfig,
  type Config,
} from "./config.js";
import { createPrismaClient } from "./db.js";
import { runBootstrap } from "./bootstrap.js";
import { log } from "./log.js";
import { buildApp } from "./http/app.js";
import { createRateLimiter } from "./http/rate-limit.js";
import { attachWs } from "./ws/handler.js";
import { initTelemetry, shutdownTelemetry } from "./telemetry/metrics.js";
import { initTracing, shutdownTracing } from "./telemetry/tracing.js";
import { initLogs, shutdownLogs } from "./telemetry/logs.js";
import { invalidateSchemaCache } from "./core/validation.js";
import { reconcileOrphanedParticipants } from "./core/reconcile.js";
import { initRedis, shutdownRedis } from "./redis.js";
import { ensureKeyLoaded } from "./crypto.js";

// One TTL sweep pass: collect the expired session ids first, then deleteMany,
// then drop each session's compiled-validator cache entry. Two queries (no
// per-session round-trip), so still O(1) DB calls regardless of batch size.
// Takes the Prisma client as a parameter — no module-level singleton — so the
// integration test can run it against its own isolated database.
export async function sweepExpiredSessions(
  prisma: PrismaClient,
): Promise<number> {
  const now = new Date();
  const expired = await prisma.session.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true },
  });
  if (expired.length === 0) return 0;
  const ids = expired.map((s) => s.id);
  const r = await prisma.session.deleteMany({ where: { id: { in: ids } } });
  for (const id of ids) invalidateSchemaCache(id);
  return r.count;
}

function startTtlSweeper(config: Config, prisma: PrismaClient): void {
  const intervalSec = config.TTL_SWEEP_SECONDS;
  if (intervalSec <= 0) {
    log.info("ttl sweeper disabled (TTL_SWEEP_SECONDS=0)");
    return;
  }
  const jitter = () =>
    Math.floor(Math.random() * Math.min(2000, intervalSec * 100));
  const tick = (): void => {
    void sweepExpiredSessions(prisma)
      .then((count) => {
        if (count > 0) log.debug("ttl swept", { count });
      })
      .catch((e) =>
        log.warn("ttl sweep error", {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
      // Recursive setTimeout (not setInterval) so each tick gets fresh jitter,
      // rather than a single fixed phase offset baked in at startup.
      .finally(() => {
        setTimeout(tick, intervalSec * 1000 + jitter());
      });
  };
  setTimeout(tick, intervalSec * 1000 + jitter());
  log.info("ttl sweeper started", { intervalSeconds: intervalSec });
}

async function main(): Promise<void> {
  // The single process-wide config + Prisma client. main() is the ONLY place a
  // relay singleton is constructed; everything downstream receives them via
  // dependency injection (function parameters or the Hono request context).
  const config = loadConfigOrExit();
  const { prisma, close: closeDb } = createPrismaClient(config.DATABASE_URL, {
    poolMax: config.DATABASE_POOL_MAX,
  });

  log.info("starting pane relay", { config: redactConfig(config) });

  // Fail fast on production misconfiguration before binding a port:
  // PUBLIC_URL must be a real public URL, PANE_SECRET_KEY must be set.
  validateProductionConfig(config);
  ensureKeyLoaded();

  await runBootstrap(prisma, config);

  // Initialise the optional Redis backing for cross-process state (event
  // pub/sub, rate limiter, WS presence). No-op when REDIS_URL is unset — the
  // relay runs single-replica on its in-process implementations. When set,
  // this fails fast if `ioredis` is missing or Redis is unreachable, so a
  // misconfigured multi-replica deployment refuses to start rather than boot
  // with no shared state.
  await initRedis();

  // Close out any orphaned `system.participant.joined` events from a previous
  // process that crashed/restarted before writing the matching `left`. At this
  // point no WebSocket is connected, so every unpaired `joined` is provably
  // stale. See core/reconcile.ts.
  await reconcileOrphanedParticipants(prisma);

  // Initialise telemetry before buildApp() so the metric instruments exist
  // when routes/middleware register. initTelemetry is async because the azure
  // exporter is dynamically imported; no-op when METRICS_ENABLED=false.
  await initTelemetry(config, prisma);
  // Wire the TracerProvider + span exporter. Only does anything in azure mode
  // (prometheus has no trace ingestion story). The HTTP/DB instrumentation
  // itself was already registered by ./telemetry/bootstrap.js, imported first
  // above.
  await initTracing(config);
  // Wire the LoggerProvider + log exporter so the relay logger bridges to
  // Application Insights "Traces". Azure mode only; no-op otherwise.
  await initLogs(config);

  // One general per-IP + per-token rate limiter, shared by the Hono app
  // (/v1/* + /s/* routes) and the WebSocket-upgrade path. Built once here — the
  // single DI root — and handed to both buildApp() and attachWs() so HTTP
  // requests and WS-upgrade attempts bucket against the same per-IP state.
  const generalLimiter = createRateLimiter(
    config.RATE_LIMIT,
    config.RATE_LIMIT_WINDOW_SECONDS * 1000,
  );

  const app = buildApp(config, prisma, generalLimiter);

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log.info("listening", { port: info.port, publicUrl: config.publicUrl });
  });
  attachWs(server, { config, prisma, generalLimiter });
  startTtlSweeper(config, prisma);

  // Flush metrics on a graceful shutdown signal. Minimal — the relay otherwise
  // just exits — but a flush lets the last scrape window's data settle.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void Promise.allSettled([
        shutdownTelemetry(),
        shutdownTracing(),
        shutdownLogs(),
        shutdownRedis(),
        // Drain the postgres `pg.Pool` (sqlite path is a no-op beyond
        // prisma.$disconnect()). Done alongside telemetry so an in-flight
        // request can complete its DB call before the pool tears down.
        closeDb(),
      ]).finally(() => process.exit(0));
    });
  }
}

// Only boot the relay when this module is the process entry point. When it is
// imported instead (e.g. the sweeper integration test importing
// `sweepExpiredSessions`), `main()` must not run — otherwise it would bind the
// HTTP port and start the TTL sweeper as an import side effect.
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => {
    log.error("fatal", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
