// Boots a real relay (HTTP + WebSocket) against a throwaway SQLite database in
// a temp dir for the Playwright browser smoke test. Mirrors the pattern in
// src/ws/handler.e2e.test.ts but uses the production `@hono/node-server`
// `serve()` adapter (not raw node:http) so the browser path is exercised end
// to end exactly as it ships.

import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { setupTestDb } from "../../src/test-helpers/db.js";

export interface RelayHandle {
  baseUrl: string;
  port: number;
  prisma: import("@prisma/client").PrismaClient;
  stop(): Promise<void>;
}

export async function startRelay(): Promise<RelayHandle> {
  const port = 4000 + Math.floor(Math.random() * 1000);

  // DB setup + migration application — shared with the vitest e2e suite via
  // src/test-helpers/db.ts, so the migration loader lives in exactly one place.
  // The browser smoke test is hardwired to SQLite (pretest:browser generates
  // the SQLite Prisma client), so force the sqlite branch by clearing any
  // ambient DATABASE_URL the developer's `.env` may have exported — otherwise
  // setupTestDb() would pick Postgres from it and the SQLite client rejects it.
  delete process.env.DATABASE_URL;
  const testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "warn";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = `http://localhost:${port}`;
  // Disable the TTL sweeper so it can't delete the session mid-test.
  process.env.TTL_SWEEP_SECONDS = "0";

  // Apply the migration before importing src/db.ts (which reads DATABASE_URL).
  // Prisma 7 needs a driver adapter on construction; route through the same
  // createPrismaClient factory the relay uses at boot so the test client
  // matches the production code path.
  const { createPrismaClient } = await import("../../src/db.js");
  const prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);

  const { serve } = await import("@hono/node-server");
  const { buildApp } = await import("../../src/http/app.js");
  const { attachWs } = await import("../../src/ws/handler.js");

  const app = buildApp();
  const server = serve({ fetch: app.fetch, port }) as unknown as Server;
  attachWs(server);
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );

  return {
    baseUrl: `http://localhost:${port}`,
    port,
    prisma,
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await prisma.$disconnect();
      await testDb.cleanup();
    },
  };
}

export interface CreatedSession {
  sessionId: string;
  humanUrl: string;
  apiKey: string;
}

// Registers an agent and creates a session whose artifact renders a visible
// marker and exposes a button that calls `pane.emit` — enough to assert the
// iframe rendered and the emit round-trip works.
export async function createSession(base: string): Promise<CreatedSession> {
  const reg = (await (
    await fetch(base + "/v1/register", { method: "POST" })
  ).json()) as { api_key: string };

  const artifact = [
    '<div id="artifact-marker">PANE ARTIFACT RENDERED</div>',
    '<button id="emit-btn">emit</button>',
    "<script>",
    'document.getElementById("emit-btn").addEventListener("click", function () {',
    '  window.pane.emit("ping", { ok: true })',
    "    .then(function (r) {",
    '      var d = document.createElement("div");',
    '      d.id = "emit-result";',
    '      d.textContent = "EMIT_OK:" + r.id;',
    "      document.body.appendChild(d);",
    "    })",
    "    .catch(function (e) {",
    '      var d = document.createElement("div");',
    '      d.id = "emit-result";',
    '      d.textContent = "EMIT_ERR:" + e.message;',
    "      document.body.appendChild(d);",
    "    });",
    "});",
    "</script>",
  ].join("\n");

  const created = (await (
    await fetch(base + "/v1/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + reg.api_key,
      },
      body: JSON.stringify({
        artifact: { type: "html-inline", source: artifact },
        schema: {
          events: {
            ping: { payload: { type: "object" }, emittedBy: ["page"] },
          },
        },
        title: "Test session",
      }),
    })
  ).json()) as { session_id: string; urls: { humans: string[] } };

  return {
    sessionId: created.session_id,
    humanUrl: created.urls.humans[0]!,
    apiKey: reg.api_key,
  };
}
