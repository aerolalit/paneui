import { serve } from "@hono/node-server";
import config, { redactConfig } from "./config.js";
import prisma from "./db.js";
import { runBootstrap } from "./bootstrap.js";
import { log } from "./log.js";
import { buildApp } from "./http/app.js";
import { attachWs } from "./ws/handler.js";

async function main(): Promise<void> {
  log.info("starting pane relay", { config: redactConfig(config) });

  await runBootstrap(prisma, config);

  const app = buildApp();

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log.info("listening", { port: info.port, publicUrl: config.publicUrl });
  });
  attachWs(server);
}

main().catch((err) => {
  log.error("fatal", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
