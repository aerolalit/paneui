import { serve } from "@hono/node-server";
import config, { redactConfig } from "./config.js";
import prisma from "./db.js";
import { runBootstrap } from "./bootstrap.js";
import { log } from "./log.js";
import { buildApp } from "./http/app.js";
import { attachWs } from "./ws/handler.js";

function startTtlSweeper(): void {
  const intervalSec = config.TTL_SWEEP_SECONDS;
  if (intervalSec <= 0) {
    log.info("ttl sweeper disabled (TTL_SWEEP_SECONDS=0)");
    return;
  }
  const jitter = () => Math.floor(Math.random() * Math.min(2000, intervalSec * 100));
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

  const app = buildApp();

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log.info("listening", { port: info.port, publicUrl: config.publicUrl });
  });
  attachWs(server);
  startTtlSweeper();
}

main().catch((err) => {
  log.error("fatal", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
