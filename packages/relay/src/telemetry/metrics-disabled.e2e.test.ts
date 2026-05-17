// Verifies that with METRICS_EXPORTER=none the relay starts fine, the metric
// helpers are no-ops, and GET /metrics is not mounted (404).
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

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";
  process.env.METRICS_ENABLED = "true";
  process.env.METRICS_EXPORTER = "none";

  delete (globalThis as { prisma?: PrismaClient }).prisma;
  ({ default: prisma } = await import("../db.js"));
  await testDb.applyMigration(prisma);

  const { loadConfig } = await import("../config.js");
  const { initTelemetry } = await import("./metrics.js");
  initTelemetry(loadConfig(process.env));

  const { buildApp } = await import("../http/app.js");
  app = buildApp();
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

describe("GET /metrics with METRICS_EXPORTER=none", () => {
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
