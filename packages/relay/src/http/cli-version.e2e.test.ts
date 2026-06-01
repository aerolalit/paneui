// End-to-end test for the CLI-version skew middleware in the real Hono app.
//
// The unit test (cli-version.test.ts) covers the middleware in isolation;
// this file verifies the wiring through `buildApp`:
//   - middleware is mounted on /v1/* but NOT on /healthz, /skills/*, /s/*
//   - the 426 response is returned in the project's standard error envelope
//   - MIN_CLI_VERSION threads through loadConfig() → buildApp() → middleware
//
// Failure here means cli-version is unhooked from the real request path,
// even if the unit test still passes.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import { loadConfig } from "../config.js";
import { buildApp } from "./app.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";
  // Raise the floor for this test file ONLY. The default 0.0.0 makes the
  // middleware a no-op — that's covered by the unit test.
  process.env.MIN_CLI_VERSION = "0.0.5";

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(loadConfig(), prisma);
});

afterAll(async () => {
  delete process.env.MIN_CLI_VERSION;
  await prisma.$disconnect();
  await testDb.cleanup();
});

describe("cli-version middleware (wired through buildApp)", () => {
  it("returns 426 cli_upgrade_required on /v1/* when the CLI is too old", async () => {
    // Hit an endpoint that requires auth — the middleware MUST fire before
    // the auth check, so a missing/invalid Authorization is irrelevant here.
    const res = await app.fetch(
      new Request("http://t/v1/panes", {
        method: "POST",
        headers: { "x-pane-cli-version": "0.0.4" },
      }),
    );
    expect(res.status).toBe(426);
    const body = (await res.json()) as {
      error: {
        code: string;
        details: { min_version: string; your_version: string };
      };
    };
    expect(body.error.code).toBe("cli_upgrade_required");
    expect(body.error.details).toEqual({
      min_version: "0.0.5",
      your_version: "0.0.4",
    });
  });

  it("does NOT gate /healthz (load balancers don't send the header)", async () => {
    const res = await app.fetch(
      new Request("http://t/healthz", {
        headers: { "x-pane-cli-version": "0.0.4" },
      }),
    );
    // /healthz returns 200 regardless of how outdated the (hypothetical)
    // caller's CLI is — it's mounted above the /v1/* middleware so monitors
    // and load-balancers keep working independent of MIN_CLI_VERSION.
    expect(res.status).toBe(200);
  });

  it("does NOT gate /skills/pane/SKILL.md (the skill must be readable to upgrade)", async () => {
    // The skill describes the upgrade flow, so an agent on an OLD CLI must
    // be able to fetch it — otherwise the only way to find out how to
    // upgrade is to upgrade first.
    const res = await app.fetch(
      new Request("http://t/skills/pane/SKILL.md", {
        headers: { "x-pane-cli-version": "0.0.4" },
      }),
    );
    expect(res.status).toBe(200);
  });
});
