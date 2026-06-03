// Cookie-authed pane lifecycle (DELETE /v1/my-panes/:id) — the human-side
// owner-shell needs a way to soft-delete from the SPA without minting an
// agent token. Mirrors /v1/panes/:id but ownership is checked against
// pane.ownerHumanId, not the calling agent.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import { hashKey, keyPrefix } from "../../keys.js";
import { seedPaneRow } from "../../test-helpers/seed.js";
import {
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
} from "../../auth/cookie.js";

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
    data: {
      email: `h-${randomBytes(4).toString("hex")}@example.com`,
      verifiedAt: new Date(),
    },
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

const withCookie = (cookie: string) => ({
  cookie: `${LOGIN_COOKIE_NAME}=${cookie}`,
});

async function seedAgent(humanId?: string): Promise<string> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const a = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      ownerHumanId: humanId ?? null,
      claimedAt: humanId ? new Date() : null,
    },
  });
  return a.id;
}

async function seedOwnedPane(opts: {
  ownerHumanId: string;
  agentId: string;
}): Promise<string> {
  const { paneId } = await seedPaneRow(prisma, {
    agentId: opts.agentId,
    status: "open",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await prisma.pane.update({
    where: { id: paneId },
    data: { ownerHumanId: opts.ownerHumanId },
  });
  return paneId;
}

describe("DELETE /v1/my-panes/:id", () => {
  it("returns 401 without a login cookie", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/my-panes/pan_x", { method: "DELETE" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the pane doesn't exist", async () => {
    const { cookie } = await seedLoggedInHuman();
    const res = await app.fetch(
      new Request("http://t/v1/my-panes/pan_missing", {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the pane belongs to a different human (no enumeration)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const other = await seedLoggedInHuman();
    const agentId = await seedAgent(other.humanId);
    const paneId = await seedOwnedPane({
      ownerHumanId: other.humanId,
      agentId,
    });
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(404);
    // Confirm we did NOT soft-delete the other human's row.
    const pane = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(pane!.deletedAt).toBeNull();
  });

  it("soft-deletes an owned pane and writes a DeletionLog row", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedAgent(humanId);
    const paneId = await seedOwnedPane({ ownerHumanId: humanId, agentId });

    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(204);

    const pane = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(pane!.deletedAt).not.toBeNull();

    const logs = await prisma.deletionLog.findMany({
      where: { entityType: "pane", entityId: paneId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.phase).toBe("soft_deleted");
    expect(logs[0]!.reason).toBe("human_delete");
    expect(logs[0]!.ownerHumanId).toBe(humanId);
    expect(logs[0]!.ownerAgentId).toBe(agentId);
  });

  it("is idempotent — a second DELETE on an already-trashed pane returns 204 without a new log row", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedAgent(humanId);
    const paneId = await seedOwnedPane({ ownerHumanId: humanId, agentId });

    await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(204);

    const logs = await prisma.deletionLog.findMany({
      where: { entityType: "pane", entityId: paneId },
    });
    // Idempotent: only the first DELETE writes a row.
    expect(logs).toHaveLength(1);
  });
});

describe("Pane favorites — POST/DELETE /v1/my-panes/:id/favorite", () => {
  it("POST /favorite requires auth", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/my-panes/pan_x/favorite", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("DELETE /favorite requires auth", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/my-panes/pan_x/favorite", { method: "DELETE" }),
    );
    expect(res.status).toBe(401);
  });

  it("starring an owned pane inserts a HumanPaneFavorite row", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedAgent(humanId);
    const paneId = await seedOwnedPane({ ownerHumanId: humanId, agentId });

    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/favorite`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(200);
    const row = await prisma.humanPaneFavorite.findUnique({
      where: { humanId_paneId: { humanId, paneId } },
    });
    expect(row).not.toBeNull();
  });

  it("starring twice is idempotent (single row)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedAgent(humanId);
    const paneId = await seedOwnedPane({ ownerHumanId: humanId, agentId });
    await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/favorite`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/favorite`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(200);
    const rows = await prisma.humanPaneFavorite.findMany({
      where: { humanId, paneId },
    });
    expect(rows).toHaveLength(1);
  });

  it("DELETE removes the row and is idempotent on already-absent rows", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedAgent(humanId);
    const paneId = await seedOwnedPane({ ownerHumanId: humanId, agentId });
    await prisma.humanPaneFavorite.create({
      data: { humanId, paneId },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/favorite`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(204);
    const row = await prisma.humanPaneFavorite.findUnique({
      where: { humanId_paneId: { humanId, paneId } },
    });
    expect(row).toBeNull();

    const res2 = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/favorite`, {
        method: "DELETE",
        headers: withCookie(cookie),
      }),
    );
    expect(res2.status).toBe(204);
  });

  it("returns 404 on a pane owned by a different human (no enumeration)", async () => {
    const { cookie } = await seedLoggedInHuman();
    const other = await seedLoggedInHuman();
    const otherAgent = await seedAgent(other.humanId);
    const paneId = await seedOwnedPane({
      ownerHumanId: other.humanId,
      agentId: otherAgent,
    });
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/favorite`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 on a soft-deleted pane", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const agentId = await seedAgent(humanId);
    const paneId = await seedOwnedPane({ ownerHumanId: humanId, agentId });
    await prisma.pane.update({
      where: { id: paneId },
      data: { deletedAt: new Date() },
    });
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/favorite`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(404);
  });
});
