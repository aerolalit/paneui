import { Hono } from "hono";
import { serve } from "@hono/node-server";
import config, { redactConfig } from "./config.js";
import prisma from "./db.js";
import { runBootstrap } from "./bootstrap.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  log.info("starting pane relay", { config: redactConfig(config) });

  await runBootstrap(prisma, config);

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log.info("listening", { port: info.port, publicUrl: config.publicUrl });
  });
}

main().catch((err) => {
  log.error("fatal", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
