// End-to-end tests for /v1/self/* — the human-authenticated routes.
// Covers the claim-code mint (the human side of §6.1) plus the
// cookie-auth gate.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import {
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
} from "../../auth/cookie.js";
import { hashClaimCode } from "../../auth/claim.js";

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(
    loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
    }),
    prisma,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

async function seedLoggedInHuman(): Promise<{
  humanId: string;
  cookie: string;
}> {
  const human = await prisma.human.create({
    data: { email: "alice@example.com", verifiedAt: new Date() },
  });
  const cookie = generateLoginCookie();
  await prisma.login.create({
    data: {
      humanId: human.id,
      cookieHash: hashLoginCookie(cookie),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { humanId: human.id, cookie };
}

describe("POST /v1/self/claim-codes", () => {
  it("requires a login cookie (401 without one)", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/self/claim-codes", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unknown cookie (401)", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/self/claim-codes", {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=lg_garbage` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("mints a claim code on a valid cookie", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/v1/self/claim-codes", {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      code: string;
      code_prefix: string;
      expires_at: string;
    };
    expect(body.code).toMatch(/^cc_/);
    expect(body.code_prefix.length).toBeGreaterThan(0);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());

    // Code stored hashed, bound to the human
    const claim = await prisma.claimCode.findUnique({
      where: { codeHash: hashClaimCode(body.code) },
    });
    expect(claim?.humanId).toBe(humanId);
    expect(claim?.consumedAt).toBeNull();
  });

  it("allows multiple outstanding claim codes per human", async () => {
    const { cookie } = await seedLoggedInHuman();
    const first = await app.fetch(
      new Request("http://t/v1/self/claim-codes", {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(first.status).toBe(201);
    const second = await app.fetch(
      new Request("http://t/v1/self/claim-codes", {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(second.status).toBe(201);
    const count = await prisma.claimCode.count();
    expect(count).toBe(2);
  });
});
