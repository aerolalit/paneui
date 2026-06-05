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

describe("PATCH /v1/self/profile", () => {
  function patchProfile(body: unknown, cookie?: string): Promise<Response> {
    return app.fetch(
      new Request("http://t/v1/self/profile", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  it("requires a login cookie (401 without one)", async () => {
    const res = await patchProfile({ name: "Alice" });
    expect(res.status).toBe(401);
  });

  it("sets the name and returns it as display_name", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const res = await patchProfile({ name: "Alice Liddell" }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; display_name: string };
    expect(body.name).toBe("Alice Liddell");
    expect(body.display_name).toBe("Alice Liddell");

    const human = await prisma.human.findUnique({ where: { id: humanId } });
    expect(human?.name).toBe("Alice Liddell");
  });

  it("trims surrounding whitespace before storing", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const res = await patchProfile({ name: "   Bob   " }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; display_name: string };
    expect(body.name).toBe("Bob");
    expect(body.display_name).toBe("Bob");

    const human = await prisma.human.findUnique({ where: { id: humanId } });
    expect(human?.name).toBe("Bob");
  });

  it("clears the name on an empty string → falls back to the email-derived display", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    // Seed an existing name first so we can prove the clear took effect.
    await patchProfile({ name: "Temporary" }, cookie);

    const res = await patchProfile({ name: "   " }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string | null;
      display_name: string;
    };
    expect(body.name).toBeNull();
    // email is alice@example.com → local part "alice" → "Alice".
    expect(body.display_name).toBe("Alice");

    const human = await prisma.human.findUnique({ where: { id: humanId } });
    expect(human?.name).toBeNull();
  });

  it("accepts an explicit null clear", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    await patchProfile({ name: "Temporary" }, cookie);

    const res = await patchProfile({ name: null }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string | null;
      display_name: string;
    };
    expect(body.name).toBeNull();
    expect(body.display_name).toBe("Alice");

    const human = await prisma.human.findUnique({ where: { id: humanId } });
    expect(human?.name).toBeNull();
  });

  it("rejects a name longer than 80 chars (400)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await patchProfile({ name: "x".repeat(81) }, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
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

describe("POST /v1/self/agents/:id/revoke-key", () => {
  async function seedClaimedAgent(
    humanId: string,
    overrides: Partial<{ revokedAt: Date | null; deletedAt: Date | null }> = {},
  ): Promise<{ agentId: string; key: string }> {
    const key = "pane_" + randomBytes(16).toString("hex");
    const agent = await prisma.agent.create({
      data: {
        name: "claimed",
        keyHash: hashKey(key),
        keyPrefix: keyPrefix(key),
        ownerHumanId: humanId,
        claimedAt: new Date(),
        revokedAt: overrides.revokedAt ?? null,
        deletedAt: overrides.deletedAt ?? null,
      },
    });
    return { agentId: agent.id, key };
  }

  it("requires a login cookie (401 without one)", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/self/agents/agt_x/revoke-key", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("404s when the agent isn't claimed by this human (no oracle)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const stranger = await prisma.human.create({
      data: { email: "bob@example.com", verifiedAt: new Date() },
    });
    const { agentId } = await seedClaimedAgent(stranger.id);
    const res = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/revoke-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s on a soft-deleted agent", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId } = await seedClaimedAgent(humanId, {
      deletedAt: new Date(),
    });
    const res = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/revoke-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("revokes an owned agent and the existing key 401s on next agent-auth", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId, key } = await seedClaimedAgent(humanId);

    // Sanity-check the key works pre-revoke. /v1/keys is the agent's own
    // metadata endpoint and is the cheapest agent-authenticated request
    // we have.
    const pre = await app.fetch(
      new Request("http://t/v1/keys", {
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    expect(pre.status).toBe(200);

    const res = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/revoke-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent_id: string;
      name: string;
      revoked_at: string;
    };
    expect(body.agent_id).toBe(agentId);
    expect(body.name).toBe("claimed");
    expect(new Date(body.revoked_at).getTime()).toBeGreaterThan(0);

    // Same key now 401s — revocation is enforced by the agent-auth gate.
    const post = await app.fetch(
      new Request("http://t/v1/keys", {
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    expect(post.status).toBe(401);
  });

  it("is idempotent on a second call (same revoked_at)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId } = await seedClaimedAgent(humanId);

    const first = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/revoke-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { revoked_at: string };

    const second = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/revoke-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { revoked_at: string };
    expect(secondBody.revoked_at).toBe(firstBody.revoked_at);
  });

  it("rotate-key on a revoked agent still 400s (no resurrection)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const { agentId } = await seedClaimedAgent(humanId);

    const revoke = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/revoke-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(revoke.status).toBe(200);

    const rotate = await app.fetch(
      new Request(`http://t/v1/self/agents/${agentId}/rotate-key`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(rotate.status).toBe(400);
    const body = (await rotate.json()) as {
      error: { code: string; hint?: string };
    };
    expect(body.error.code).toBe("invalid_request");
    // The updated hint — the old "unrevoke first" copy is gone.
    expect(body.error.hint ?? "").toMatch(/revocation is permanent/);
  });
});
