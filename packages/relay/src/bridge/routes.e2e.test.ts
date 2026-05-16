// End-to-end test for the bridge routes — exercises the /presence endpoint
// (polled by the shell to keep the agent-presence pill fresh) through the
// real Hono app. DB engine follows DATABASE_URL (sqlite or postgres).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

  delete (globalThis as { prisma?: PrismaClient }).prisma;
  ({ default: prisma } = await import("../db.js"));
  await testDb.applyMigration(prisma);
  ({ hashKey, keyPrefix } = await import("../keys.js"));
  const { buildApp } = await import("../http/app.js");
  app = buildApp();
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

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

// Seed an agent + open session + one human participant, returning the
// participant token (the bridge URL credential) and the agent id.
async function seedSession(opts?: { agentLastUsedAt?: Date }): Promise<{
  token: string;
  agentId: string;
  sessionId: string;
}> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      lastUsedAt: opts?.agentLastUsedAt ?? null,
    },
  });
  const sessionId = "ses_" + randomBytes(8).toString("hex");
  await prisma.session.create({
    data: {
      id: sessionId,
      agentId: agent.id,
      artifactType: "html-inline",
      artifactSource: "<html></html>",
      eventSchema: minimalSchema,
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const token = randomBytes(32).toString("base64url");
  await prisma.participant.create({
    data: {
      sessionId,
      kind: "human",
      identityId: "human-1",
      tokenHash: hashKey(token),
      tokenPrefix: token.slice(0, 8),
    },
  });
  return { token, agentId: agent.id, sessionId };
}

describe("bridge /presence", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the three presence fields as JSON", async () => {
    const usedAt = new Date(Date.now() - 5000);
    const { token } = await seedSession({ agentLastUsedAt: usedAt });

    const res = await app.fetch(new Request(`http://t/s/${token}/presence`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      agentLive: boolean;
      agentLastEventAt: string | null;
      agentLastUsedAt: string | null;
    };
    expect(body.agentLive).toBe(false);
    expect(body.agentLastEventAt).toBeNull();
    expect(body.agentLastUsedAt).toBe(usedAt.toISOString());
  });

  it("reports agentLastEventAt from the most recent agent-authored event", async () => {
    const { token, sessionId } = await seedSession();
    await prisma.event.create({
      data: {
        sessionId,
        authorKind: "agent",
        authorId: "agent-x",
        type: "review.commentAdded",
        data: { body: "hi" },
      },
    });

    const res = await app.fetch(new Request(`http://t/s/${token}/presence`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentLastEventAt: string | null };
    expect(body.agentLastEventAt).not.toBeNull();
  });

  it("404s on a bad token", async () => {
    const res = await app.fetch(new Request("http://t/s/not-a-real-token/presence"));
    expect(res.status).toBe(404);
  });

  it("404s on a well-formed but unknown token", async () => {
    const bogus = randomBytes(32).toString("base64url");
    const res = await app.fetch(new Request(`http://t/s/${bogus}/presence`));
    expect(res.status).toBe(404);
  });
});
