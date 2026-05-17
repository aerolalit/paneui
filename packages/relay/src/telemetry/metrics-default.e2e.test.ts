// Verifies the DEFAULT telemetry posture: with METRICS_EXPORTER unset the
// config resolves to "none", the relay starts cleanly, and GET /metrics is not
// mounted (404).
//
// Separate file from the other telemetry e2e tests: initTelemetry() registers
// a PROCESS-GLOBAL MeterProvider and config is a module singleton — a fresh
// Vitest file gives a clean module registry so the unset-default path is
// exercised in isolation.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";
  // METRICS_EXPORTER deliberately NOT set — exercise the default ("none").
  delete process.env.METRICS_EXPORTER;
  delete process.env.METRICS_ENABLED;

  delete (globalThis as { prisma?: PrismaClient }).prisma;
  ({ default: prisma } = await import("../db.js"));
  await testDb.applyMigration(prisma);

  const { loadConfig } = await import("../config.js");
  const config = loadConfig(process.env);
  // The default exporter is "none".
  expect(config.METRICS_EXPORTER).toBe("none");

  const { initTelemetry } = await import("./metrics.js");
  await initTelemetry(config);

  const { buildApp } = await import("../http/app.js");
  app = buildApp();
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

describe("default telemetry posture (METRICS_EXPORTER unset)", () => {
  it("does not mount /metrics — returns 404", async () => {
    const res = await app.fetch(new Request("http://t/metrics"));
    expect(res.status).toBe(404);
  });

  it("the relay still serves normal routes", async () => {
    const res = await app.fetch(new Request("http://t/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("metrics collection is inactive by default", async () => {
    const { metricsEnabled } = await import("./metrics.js");
    expect(metricsEnabled()).toBe(false);
  });
});
