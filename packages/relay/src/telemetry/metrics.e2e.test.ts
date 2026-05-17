// End-to-end test for the OpenTelemetry metrics endpoint.
//
// Isolated in its own file because initTelemetry() registers a PROCESS-GLOBAL
// MeterProvider (metrics.setGlobalMeterProvider) — a fresh Vitest file gives a
// clean module registry so this test can init telemetry without clashing with
// the metrics-disabled test (metrics-disabled.e2e.test.ts) or other suites.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;
let hashKey: typeof import("../keys.js").hashKey;
let keyPrefix: typeof import("../keys.js").keyPrefix;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";
  process.env.METRICS_ENABLED = "true";
  process.env.METRICS_EXPORTER = "prometheus";

  // Inject the Prisma client + config directly. Module imports stay dynamic
  // here because initTelemetry() registers a PROCESS-GLOBAL MeterProvider — a
  // fresh module registry keeps this isolated from the other telemetry suites.
  const { createPrismaClient } = await import("../db.js");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  ({ hashKey, keyPrefix } = await import("../keys.js"));

  const { loadConfig } = await import("../config.js");
  const config = loadConfig(process.env);
  const { initTelemetry } = await import("./metrics.js");
  await initTelemetry(config, prisma);

  const { buildApp } = await import("../http/app.js");
  app = buildApp(config, prisma);
});

afterAll(async () => {
  const { shutdownTelemetry } = await import("./metrics.js");
  await shutdownTelemetry();
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: agent.id, apiKey };
}

const minimalSchema = {
  events: {
    "review.commentAdded": {
      payload: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      emittedBy: ["page", "agent"],
    },
  },
};

describe("GET /metrics (metrics enabled)", () => {
  it("serves Prometheus text and reflects activity", async () => {
    await testDb.truncateAll(prisma);
    const { apiKey } = await seedAgent();

    // Drive an agent self-registration so pane_registrations_total is non-zero.
    const reg = await app.fetch(
      new Request("http://t/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(reg.status).toBe(201);

    // Drive a session creation so pane_sessions_created_total is non-zero.
    const create = await app.fetch(
      new Request("http://t/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          artifact: { type: "html-inline", source: "<html></html>" },
          schema: minimalSchema,
        }),
      }),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      session_id: string;
      tokens: { agent: string };
    };

    // Post an event so pane_events_written_total is non-zero.
    const emit = await app.fetch(
      new Request(`http://t/v1/sessions/${created.session_id}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.tokens.agent}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "review.commentAdded",
          data: { body: "hi" },
        }),
      }),
    );
    expect(emit.status).toBe(201);

    // Drive an error so pane_errors_total{code="not_found"} is non-zero.
    const miss = await app.fetch(
      new Request("http://t/v1/sessions/ses_missing", {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(miss.status).toBe(404);

    const res = await app.fetch(new Request("http://t/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);

    const body = await res.text();
    expect(body).toContain("pane_sessions_created_total");
    expect(body).toContain("pane_events_written_total");
    expect(body).toContain("pane_registrations_total");
    expect(body).toContain("pane_errors_total");
    expect(body).toContain("pane_http_request_duration_seconds");
    // The counter incremented by the session create above.
    expect(body).toMatch(/pane_sessions_created_total(\{[^}]*\})?\s+[1-9]/);
    // The error counter carries the low-cardinality `code` label.
    expect(body).toMatch(/pane_errors_total\{[^}]*code="not_found"/);
  });
});
