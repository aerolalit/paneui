// Boots a real relay (HTTP + WebSocket) against a throwaway SQLite database in
// a temp dir for the Playwright browser smoke test. Mirrors the pattern in
// src/ws/handler.e2e.test.ts but uses the production `@hono/node-server`
// `serve()` adapter (not raw node:http) so the browser path is exercised end
// to end exactly as it ships.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

export interface RelayHandle {
  baseUrl: string;
  port: number;
  prisma: import("@prisma/client").PrismaClient;
  stop(): Promise<void>;
}

function migrationsSql(): string {
  const dir = "prisma/migrations";
  const entries = readdirSync(dir).filter(
    (e) => statSync(join(dir, e)).isDirectory(),
  );
  entries.sort();
  const last = entries[entries.length - 1];
  if (!last) throw new Error("no migrations found");
  return readFileSync(join(dir, last, "migration.sql"), "utf8");
}

export async function startRelay(): Promise<RelayHandle> {
  const dir = mkdtempSync(join(tmpdir(), "pane-pw-"));
  const port = 4000 + Math.floor(Math.random() * 1000);

  process.env.DATABASE_URL = "file:" + join(dir, "pane.db");
  process.env.LOG_LEVEL = "warn";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = `http://localhost:${port}`;
  // Disable the TTL sweeper so it can't delete the session mid-test.
  process.env.TTL_SWEEP_SECONDS = "0";

  // Apply the migration before importing src/db.ts (which reads DATABASE_URL).
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const raw = migrationsSql()
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const stmt of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
    await prisma.$executeRawUnsafe(stmt);
  }

  const { serve } = await import("@hono/node-server");
  const { buildApp } = await import("../../src/http/app.js");
  const { attachWs } = await import("../../src/ws/handler.js");

  const app = buildApp();
  const server = serve({ fetch: app.fetch, port }) as unknown as Server;
  attachWs(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));

  return {
    baseUrl: `http://localhost:${port}`,
    port,
    prisma,
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await prisma.$disconnect();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
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
    '    .then(function (r) {',
    '      var d = document.createElement("div");',
    '      d.id = "emit-result";',
    '      d.textContent = "EMIT_OK:" + r.id;',
    "      document.body.appendChild(d);",
    "    })",
    '    .catch(function (e) {',
    '      var d = document.createElement("div");',
    '      d.id = "emit-result";',
    '      d.textContent = "EMIT_ERR:" + e.message;',
    "      document.body.appendChild(d);",
    "    });",
    "});",
    "<\/script>",
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
          events: { ping: { payload: { type: "object" }, emittedBy: ["page"] } },
        },
      }),
    })
  ).json()) as { session_id: string; urls: { humans: string[] } };

  return {
    sessionId: created.session_id,
    humanUrl: created.urls.humans[0]!,
    apiKey: reg.api_key,
  };
}
