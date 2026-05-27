// End-to-end tests for /v1/agents/claim — the agent side of the claim
// flow (§6.1). Companion to self.e2e.test.ts which covers the human side.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";
import { generateClaimCode, hashClaimCode } from "../../auth/claim.js";

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

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      name: "test-agent",
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: agent.id, apiKey };
}

async function seedHuman(email = "alice@example.com"): Promise<string> {
  const human = await prisma.human.create({
    data: { email, verifiedAt: new Date() },
  });
  return human.id;
}

async function mintCode(
  humanId: string,
  opts: { ttlMs?: number } = {},
): Promise<{ raw: string; codeHash: string }> {
  const raw = generateClaimCode();
  const codeHash = hashClaimCode(raw);
  await prisma.claimCode.create({
    data: {
      humanId,
      codeHash,
      expiresAt: new Date(Date.now() + (opts.ttlMs ?? 60_000)),
    },
  });
  return { raw, codeHash };
}

describe("POST /v1/agents/claim", () => {
  it("requires an agent bearer token", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "cc_anything" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const { apiKey } = await seedAgent();
    const res = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ notCode: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown code with 400 invalid_code", async () => {
    const { apiKey } = await seedAgent();
    const res = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ code: "cc_unknown_1234567890" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_code");
  });

  it("rejects an expired code", async () => {
    const { apiKey } = await seedAgent();
    const humanId = await seedHuman();
    const { raw } = await mintCode(humanId, { ttlMs: -1000 });
    const res = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ code: raw }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("on success: binds the agent to the human, sets claimedAt", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const humanId = await seedHuman();
    const { raw, codeHash } = await mintCode(humanId);

    const res = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ code: raw }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      owner_human_id: string;
      claimed_at: string;
    };
    expect(body.ok).toBe(true);
    expect(body.owner_human_id).toBe(humanId);

    // Agent now bound
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    expect(agent?.ownerHumanId).toBe(humanId);
    expect(agent?.claimedAt).not.toBeNull();

    // Claim code consumed
    const claim = await prisma.claimCode.findUnique({ where: { codeHash } });
    expect(claim?.consumedAt).not.toBeNull();
    expect(claim?.consumedByAgentId).toBe(agentId);

    // Agent's API key still works (cross-check: a no-op tasteGet style request)
    // — covered indirectly by the fact that we used it for this request.
  });

  it("rejects a replay of an already-consumed code", async () => {
    const { apiKey } = await seedAgent();
    const humanId = await seedHuman();
    const { raw } = await mintCode(humanId);

    const ok = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ code: raw }),
      }),
    );
    expect(ok.status).toBe(200);

    // Different agent tries to use the same code
    const { apiKey: apiKey2 } = await seedAgent();
    const replay = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey2}`,
        },
        body: JSON.stringify({ code: raw }),
      }),
    );
    expect(replay.status).toBe(400);
  });

  it("rejects re-claim of an already-claimed agent with 409", async () => {
    const { apiKey } = await seedAgent();
    const humanId = await seedHuman();
    const { raw: first } = await mintCode(humanId);
    const { raw: second } = await mintCode(humanId);

    const ok = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ code: first }),
      }),
    );
    expect(ok.status).toBe(200);

    const reclaim = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ code: second }),
      }),
    );
    expect(reclaim.status).toBe(409);
    const body = (await reclaim.json()) as { error: { code: string } };
    expect(body.error.code).toBe("agent_already_claimed");
  });

  it("migrates ownerHumanId onto the agent's existing surfaces", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const humanId = await seedHuman();

    // Seed a template + version + a surface owned by this agent.
    const tmpl = await prisma.template.create({
      data: { ownerId: agentId, name: "t" },
    });
    const tv = await prisma.templateVersion.create({
      data: {
        templateId: tmpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p/>",
      },
    });
    const surface = await prisma.surface.create({
      data: {
        id: "ses_test",
        agentId,
        templateVersionId: tv.id,
        title: "t",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(surface.ownerHumanId).toBeNull();

    const { raw } = await mintCode(humanId);
    const res = await app.fetch(
      new Request("http://t/v1/agents/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ code: raw }),
      }),
    );
    expect(res.status).toBe(200);

    const after = await prisma.surface.findUnique({
      where: { id: surface.id },
    });
    expect(after?.ownerHumanId).toBe(humanId);
  });
});
