// End-to-end coverage for the REGISTRATION_MODE gate on POST /v1/register.
//
// Three modes, one app each (the mode is fixed at buildApp/loadConfig time):
//   closed - DEFAULT. The endpoint returns 404.
//   secret - Requires `Authorization: Bearer <REGISTRATION_SECRET>`; a
//            missing/wrong token is 401, the correct token is 201.
//   open   - Public; 201 with no auth at all.
// The rate-limit behaviour for the secret/open modes lives in
// register.e2e.test.ts and register-unlimited.e2e.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

/** POST /v1/register against the given app, optionally with a Bearer token. */
function post(app: Hono, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return app.fetch(
    new Request("http://t/v1/register", { method: "POST", headers }),
  );
}

describe("POST /v1/register — REGISTRATION_MODE=closed (default)", () => {
  let app: Hono;

  beforeAll(() => {
    // No REGISTRATION_MODE supplied — must default to closed.
    app = buildApp(
      loadConfig({
        DATABASE_URL: testDb.dbUrl,
        PUBLIC_URL: "http://localhost:3000",
      }),
      prisma,
    );
  });

  it("returns 404 with no Authorization header", async () => {
    await testDb.truncateAll(prisma);
    const res = await post(app);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("returns 404 even when a Bearer token is sent", async () => {
    await testDb.truncateAll(prisma);
    const res = await post(app, "anything");
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/register — REGISTRATION_MODE=secret", () => {
  let app: Hono;
  const SECRET = "s3cr3t-registration-token";

  beforeAll(() => {
    app = buildApp(
      loadConfig({
        DATABASE_URL: testDb.dbUrl,
        PUBLIC_URL: "http://localhost:3000",
        REGISTRATION_MODE: "secret",
        REGISTRATION_SECRET: SECRET,
      }),
      prisma,
    );
  });

  it("returns 401 with no Authorization header", async () => {
    await testDb.truncateAll(prisma);
    const res = await post(app);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 401 with a wrong secret", async () => {
    await testDb.truncateAll(prisma);
    const res = await post(app, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns 401 with a same-length but wrong secret", async () => {
    await testDb.truncateAll(prisma);
    const res = await post(app, "x".repeat(SECRET.length));
    expect(res.status).toBe(401);
  });

  it("returns 201 with the correct Bearer secret", async () => {
    await testDb.truncateAll(prisma);
    const res = await post(app, SECRET);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent_id: string;
      api_key: string;
      key_prefix: string;
    };
    expect(body.agent_id).toBeTruthy();
    expect(body.api_key).toMatch(/^pane_/);
    expect(body.api_key.startsWith(body.key_prefix)).toBe(true);
  });

  it("fails fast at boot when REGISTRATION_SECRET is missing", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: testDb.dbUrl,
        PUBLIC_URL: "http://localhost:3000",
        REGISTRATION_MODE: "secret",
      }),
    ).toThrow(/REGISTRATION_SECRET/);
  });
});

describe("POST /v1/register — REGISTRATION_MODE=open", () => {
  let app: Hono;

  beforeAll(() => {
    app = buildApp(
      loadConfig({
        DATABASE_URL: testDb.dbUrl,
        PUBLIC_URL: "http://localhost:3000",
        REGISTRATION_MODE: "open",
      }),
      prisma,
    );
  });

  it("returns 201 with no Authorization header", async () => {
    await testDb.truncateAll(prisma);
    const res = await post(app);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent_id: string;
      api_key: string;
      key_prefix: string;
    };
    expect(body.agent_id).toBeTruthy();
    expect(body.api_key).toMatch(/^pane_/);
    expect(body.api_key.startsWith(body.key_prefix)).toBe(true);
  });

  it("returns 201 even when an (unnecessary) Bearer token is sent", async () => {
    await testDb.truncateAll(prisma);
    const res = await post(app, "anything");
    expect(res.status).toBe(201);
  });
});
