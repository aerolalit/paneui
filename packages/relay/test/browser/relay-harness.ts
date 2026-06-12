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
  // Disable the TTL sweeper so it can't delete the pane mid-test.
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
  const { loadConfig } = await import("../../src/config.js");
  const { makeDevProvider } = await import("../../src/auth/providers/dev.js");
  const { createRateLimiter } = await import("../../src/http/rate-limit.js");

  // Mirror index.ts's DI root: one config + one shared general limiter handed to
  // BOTH buildApp() and attachWs() (they no longer read ambient env / module
  // singletons). Dev email provider so the owner-shell / magic-link routes
  // construct, even though the browser tests authenticate via a seeded cookie.
  const config = loadConfig({
    DATABASE_URL: testDb.dbUrl,
    PUBLIC_URL: `http://localhost:${port}`,
    EMAIL_PROVIDER: "dev",
    // The smoke test's createSession() self-registers an agent over /v1/register,
    // which 404s under the default `closed` mode. Open it for the throwaway DB.
    REGISTRATION_MODE: "open",
  });
  const generalLimiter = createRateLimiter(
    config.RATE_LIMIT,
    config.RATE_LIMIT_WINDOW_SECONDS * 1000,
  );
  const app = buildApp(
    config,
    prisma,
    generalLimiter,
    undefined,
    undefined,
    makeDevProvider({ isProduction: false }),
  );
  const server = serve({ fetch: app.fetch, port }) as unknown as Server;
  attachWs(server, { config, prisma, generalLimiter });
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
  paneId: string;
  humanUrl: string;
  apiKey: string;
}

// Registers an agent and creates a pane whose template renders a visible
// marker and exposes a button that calls `pane.emit` — enough to assert the
// iframe rendered and the emit round-trip works.
export async function createSession(base: string): Promise<CreatedSession> {
  const reg = (await (
    await fetch(base + "/v1/register", { method: "POST" })
  ).json()) as { api_key: string };

  const template = [
    '<div id="template-marker">PANE ARTIFACT RENDERED</div>',
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
    await fetch(base + "/v1/panes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + reg.api_key,
      },
      body: JSON.stringify({
        // The inline event vocabulary now rides INSIDE template.event_schema
        // (a top-level `schema` is ignored, yielding a view-only pane whose
        // pane.emit fails unknown_event_type).
        template: {
          name: "ping",
          type: "html-inline",
          source: template,
          event_schema: {
            events: {
              ping: { payload: { type: "object" }, emittedBy: ["page"] },
            },
          },
        },
        title: "Test pane",
      }),
    })
  ).json()) as { pane_id: string; urls: { humans: string[] } };

  return {
    paneId: created.pane_id,
    humanUrl: created.urls.humans[0]!,
    apiKey: reg.api_key,
  };
}

export interface OwnerSession {
  cookie: string;
  humanId: string;
  paneIds: string[];
}

// Seed a logged-in human who owns `count` panes, returned newest-first — enough
// to make the /home Panes list taller than the viewport so scroll-restore is
// observable. Writes straight through prisma (mirrors seedOwnedPane in the
// owner-shell e2e), since there's no public "create as owner" HTTP path.
export async function createOwnerSession(
  prisma: import("@prisma/client").PrismaClient,
  count = 25,
): Promise<OwnerSession> {
  const { generateLoginCookie, hashLoginCookie } =
    await import("../../src/auth/cookie.js");
  const { generateApiKey, generatePaneId, hashKey, keyPrefix } =
    await import("../../src/keys.js");

  const human = await prisma.human.create({
    data: { email: `owner-${Date.now()}@example.com`, verifiedAt: new Date() },
  });
  const cookie = generateLoginCookie();
  await prisma.login.create({
    data: {
      humanId: human.id,
      cookieHash: hashLoginCookie(cookie),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const agentKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      keyHash: hashKey(agentKey),
      keyPrefix: keyPrefix(agentKey),
      name: "browser-owner-agent",
      ownerHumanId: human.id,
      claimedAt: new Date(),
    },
  });
  const template = await prisma.template.create({
    data: { name: "Browser pane", ownerId: agent.id, slug: `bp-${agent.id}` },
  });
  const templateVersion = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: '<div id="m">pane body</div>',
      eventSchema: {
        events: { ping: { payload: { type: "object" }, emittedBy: ["page"] } },
      },
    },
  });

  const paneIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const pane = await prisma.pane.create({
      data: {
        id: generatePaneId(),
        agentId: agent.id,
        ownerHumanId: human.id,
        templateVersionId: templateVersion.id,
        title: `Pane number ${i + 1}`,
        status: "open",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    paneIds.unshift(pane.id); // newest-first, matching the /home list order
  }

  return { cookie, humanId: human.id, paneIds };
}
