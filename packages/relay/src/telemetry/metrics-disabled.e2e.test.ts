// Verifies that with METRICS_EXPORTER=none the relay starts fine and the
// metric helpers are no-ops.
//
// Separate file from metrics.e2e.test.ts: initTelemetry() and config are
// module singletons evaluated once per process — a fresh Vitest file gives a
// clean module registry to re-evaluate them with metrics off.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";
  process.env.METRICS_ENABLED = "true";
  process.env.METRICS_EXPORTER = "none";

  // Inject the Prisma client + config directly. Module imports stay dynamic
  // here because initTelemetry() registers a PROCESS-GLOBAL MeterProvider — a
  // fresh module registry keeps the metrics-off path isolated.
  const { createPrismaClient } = await import("../db.js");
  ({ prisma, close: closeDb } = createPrismaClient(testDb.dbUrl));
  await testDb.applyMigration(prisma);

  const { loadConfig } = await import("../config.js");
  const config = loadConfig(process.env);
  const { initTelemetry } = await import("./metrics.js");
  await initTelemetry(config, prisma);

  const { buildApp } = await import("../http/app.js");
  app = buildApp(config, prisma);
});

afterAll(async () => {
  await closeDb();
  await testDb.cleanup();
});

describe("telemetry with METRICS_EXPORTER=none", () => {
  it("the relay still serves normal routes", async () => {
    const res = await app.fetch(new Request("http://t/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("instrument helpers are safe no-ops when metrics are disabled", async () => {
    const { recordSessionCreated, recordError, metricsEnabled } =
      await import("./metrics.js");
    expect(metricsEnabled()).toBe(false);
    // Must not throw.
    expect(() => {
      recordSessionCreated();
      recordError("not_found");
    }).not.toThrow();
  });
});
