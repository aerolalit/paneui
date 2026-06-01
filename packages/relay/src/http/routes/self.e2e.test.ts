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

import { hashKey, keyPrefix } from "../../keys.js";

describe("POST /v1/self/agents/:id/rotate-key", () => {
  async function seedClaimedAgent(
    humanId: string,
    overrides: Partial<{ revokedAt: Date | null; deletedAt: Date | null }> = {},
  ): Promise<{ agentId: string; oldKey: string }> {
    const oldKey = "pane_" + randomBytes(16).toString("hex");
    const agent = await prisma.agent.create({
      data: {
        name: "claimed",
        keyHash: hashKey(oldKey),
        keyPrefix: keyPrefix(oldKey),
        ownerHumanId: humanId,
        claimedAt: new Date(),
        revokedAt: overrides.revokedAt ?? null,
        deletedAt: overrides.deletedAt ?? null,
      },
    });
    return { agentId: agent.id, oldKey };
  }

  it("requires a login cookie (401 without one)", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/self/agents/agt_x/rotate-key", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("404s when the agent isn't claimed by this human (no oracle)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    // An agent owned by a different (unclaimed) human shouldn't even
    // reveal its existence through this route.
    const stranger = await prisma.human.create({
      data: { email: "bob@example.com", verifiedAt: new Date() },
    });
    const { agentId } = await seedClaimedAgent(stranger.id);
    void humanId;
    const res = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/rotate-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s on an unknown agent id", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/v1/self/agents/agt_does_not_exist/rotate-key", {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("mints a fresh key, invalidates the old one, and returns the new key once", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId, oldKey } = await seedClaimedAgent(humanId);
    const oldHash = hashKey(oldKey);

    const res = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/rotate-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent_id: string;
      name: string;
      api_key: string;
      key_prefix: string;
      rotated_at: string;
    };

    // The response carries the raw key — the only chance the human gets
    // to see it.
    expect(body.agent_id).toBe(agentId);
    expect(body.api_key).toMatch(/^pane_[a-f0-9]{32}$/);
    expect(body.api_key).not.toBe(oldKey);
    expect(body.key_prefix).toBe(keyPrefix(body.api_key));

    // The agent row reflects the new hash + prefix; the old hash is gone.
    const after = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { keyHash: true, keyPrefix: true },
    });
    expect(after?.keyHash).toBe(hashKey(body.api_key));
    expect(after?.keyHash).not.toBe(oldHash);
    expect(after?.keyPrefix).toBe(body.key_prefix);
  });

  it("rejects rotation on a revoked agent (400, key not changed)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId, oldKey } = await seedClaimedAgent(humanId, {
      revokedAt: new Date(),
    });
    const oldHash = hashKey(oldKey);

    const res = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/rotate-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");

    // The keyHash is unchanged — rotation must be all-or-nothing.
    const after = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { keyHash: true },
    });
    expect(after?.keyHash).toBe(oldHash);
  });

  it("404s on a soft-deleted agent", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId } = await seedClaimedAgent(humanId, {
      deletedAt: new Date(),
    });
    const res = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/rotate-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(404);
  });
});
