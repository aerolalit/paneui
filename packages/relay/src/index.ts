// IMPORTANT: telemetry/bootstrap MUST be the first import. It registers the
// HTTP auto-instrumentation, which monkey-patches Node's `http` module — that
// patch must be installed before `@hono/node-server` (below) loads `http`.
import "./telemetry/bootstrap.js";
import { serve } from "@hono/node-server";
import config, { redactConfig } from "./config.js";
import prisma from "./db.js";
import { runBootstrap } from "./bootstrap.js";
import { log } from "./log.js";
import { buildApp } from "./http/app.js";
import { attachWs } from "./ws/handler.js";
import { initTelemetry, shutdownTelemetry } from "./telemetry/metrics.js";
import { initTracing, shutdownTracing } from "./telemetry/tracing.js";
import { initLogs, shutdownLogs } from "./telemetry/logs.js";

function startTtlSweeper(): void {
  const intervalSec = config.TTL_SWEEP_SECONDS;
  if (intervalSec <= 0) {
    log.info("ttl sweeper disabled (TTL_SWEEP_SECONDS=0)");
    return;
  }
  const jitter = () =>
    Math.floor(Math.random() * Math.min(2000, intervalSec * 100));
  const tick = (): void => {
    void prisma.session
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .then((r) => {
        if (r.count > 0) log.debug("ttl swept", { count: r.count });
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
  log.info("starting pane relay", { config: redactConfig(config) });

  await runBootstrap(prisma, config);

  // Initialise telemetry before buildApp() so the metric instruments exist
  // when routes/middleware register. initTelemetry is async because the azure
  // exporter is dynamically imported; no-op when METRICS_ENABLED=false.
  await initTelemetry(config);
  // Wire the TracerProvider + span exporter. Only does anything in azure mode
  // (prometheus has no trace ingestion story). The HTTP/DB instrumentation
  // itself was already registered by ./telemetry/bootstrap.js, imported first
  // above.
  await initTracing(config);
  // Wire the LoggerProvider + log exporter so the relay logger bridges to
  // Application Insights "Traces". Azure mode only; no-op otherwise.
  await initLogs(config);

  const app = buildApp();

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log.info("listening", { port: info.port, publicUrl: config.publicUrl });
  });
  attachWs(server);
  startTtlSweeper();

  // Flush metrics on a graceful shutdown signal. Minimal — the relay otherwise
  // just exits — but a flush lets the last scrape window's data settle.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void Promise.allSettled([
        shutdownTelemetry(),
        shutdownTracing(),
        shutdownLogs(),
      ]).finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  log.error("fatal", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
