// End-to-end tests for the #501 attachment-token TTL cascade on pane create.
//
// An agent can bake a `/b/<token>` capability URL straight into a pane's
// `input_data` (the photobook pattern). Those tokens carry their own TTL,
// independent of the pane's — an agent-scope token defaults to 24h. When the
// pane outlives the token, the page stays up but `<img src="/b/<token>">`
// 404s partway through, a silent delayed breakage.
//
// On create, the relay now pulls every token embedded in `input_data` and
// extends any that would expire before the pane to the pane's own expiry, so
// a referenced capability URL lives at least as long as the pane using it.
//
// These tests seed Attachment + AttachmentToken rows directly (the cascade is
// pure DB — it keys off tokenHash + ownership and never touches blob storage),
// which keeps the suite free of a blob store / sharp.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { hashKey, keyPrefix } from "../../keys.js";
import { buildApp } from "../app.js";
import { generateBlobToken } from "../../attachments/tokens.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

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
      // Allow a 1-year pane so the cascade has a long target to extend to.
      MAX_TTL_SECONDS: String(366 * 24 * 3600),
    }),
    prisma,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: agent.id, apiKey };
}

/** Seed a ready agent-scope attachment owned by `ownerId`. */
async function seedAttachment(ownerId: string): Promise<string> {
  const att = await prisma.attachment.create({
    data: {
      ownerId,
      scope: "agent",
      mime: "image/jpeg",
      size: 1234,
      sha256: randomBytes(32).toString("hex"),
      storageKey: `att_${randomBytes(8).toString("hex")}`,
      status: "ready",
      confirmedAt: new Date(),
    },
  });
  return att.id;
}

interface SeededToken {
  url: string;
  tokenId: string;
}

/**
 * Mint an AttachmentToken row directly and return its `/b/<token>` URL plus the
 * row id. The raw token is only known here (the DB stores its hash), which is
 * exactly the shape an agent holds after `pane attachment token mint`.
 */
async function seedToken(
  attachmentId: string,
  opts: { expiresAt: Date; once?: boolean; revoked?: boolean },
): Promise<SeededToken> {
  const minted = generateBlobToken();
  const row = await prisma.attachmentToken.create({
    data: {
      attachmentId,
      tokenHash: minted.hash,
      tokenPrefix: minted.prefix,
      expiresAt: opts.expiresAt,
      once: opts.once ?? false,
      revokedAt: opts.revoked ? new Date() : null,
    },
  });
  return { url: `http://localhost:3000/b/${minted.token}`, tokenId: row.id };
}

const eventSchema = {
  events: {
    ping: { payload: { type: "object" }, emittedBy: ["page", "agent"] },
  },
};

async function createPane(
  apiKey: string,
  input_data: unknown,
  ttlSeconds: number,
): Promise<Response> {
  return app.fetch(
    new Request("http://t/v1/panes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "TTL cascade test pane",
        template: {
          name: "ttl-cascade",
          type: "html-inline",
          source: "<html></html>",
          event_schema: eventSchema,
        },
        input_data,
        ttl: ttlSeconds,
      }),
    }),
  );
}

const HOUR = 3600;
const YEAR_S = 365 * 24 * 3600;

describe("pane create — attachment-token TTL cascade (#501)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("extends a short agent-scope token to match a longer pane", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const attId = await seedAttachment(agentId);
    const shortExpiry = new Date(Date.now() + 24 * HOUR * 1000); // 24h
    const { url, tokenId } = await seedToken(attId, { expiresAt: shortExpiry });

    const res = await createPane(apiKey, { hero: url }, YEAR_S);
    expect(res.status).toBe(201);
    const { expires_at } = (await res.json()) as { expires_at: string };
    const paneExpiry = new Date(expires_at).getTime();

    const tok = await prisma.attachmentToken.findUnique({
      where: { id: tokenId },
    });
    // The token now expires with the pane, not at its original 24h.
    expect(tok!.expiresAt.getTime()).toBe(paneExpiry);
    expect(tok!.expiresAt.getTime()).toBeGreaterThan(shortExpiry.getTime());
  });

  it("leaves a token that already outlives the pane untouched", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const attId = await seedAttachment(agentId);
    const longExpiry = new Date(Date.now() + YEAR_S * 1000);
    const { url, tokenId } = await seedToken(attId, { expiresAt: longExpiry });

    // Pane only lives an hour — shorter than the token. Nothing to bump.
    const res = await createPane(apiKey, { hero: url }, HOUR);
    expect(res.status).toBe(201);

    const tok = await prisma.attachmentToken.findUnique({
      where: { id: tokenId },
    });
    // Unchanged — the cascade never SHORTENS a token.
    expect(tok!.expiresAt.getTime()).toBe(longExpiry.getTime());
  });

  it("does not extend a `once` token (deliberately ephemeral)", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const attId = await seedAttachment(agentId);
    const shortExpiry = new Date(Date.now() + 24 * HOUR * 1000);
    const { url, tokenId } = await seedToken(attId, {
      expiresAt: shortExpiry,
      once: true,
    });

    const res = await createPane(apiKey, { hero: url }, YEAR_S);
    expect(res.status).toBe(201);

    const tok = await prisma.attachmentToken.findUnique({
      where: { id: tokenId },
    });
    expect(tok!.expiresAt.getTime()).toBe(shortExpiry.getTime());
  });

  it("does not extend a revoked token", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const attId = await seedAttachment(agentId);
    const shortExpiry = new Date(Date.now() + 24 * HOUR * 1000);
    const { url, tokenId } = await seedToken(attId, {
      expiresAt: shortExpiry,
      revoked: true,
    });

    const res = await createPane(apiKey, { hero: url }, YEAR_S);
    expect(res.status).toBe(201);

    const tok = await prisma.attachmentToken.findUnique({
      where: { id: tokenId },
    });
    expect(tok!.expiresAt.getTime()).toBe(shortExpiry.getTime());
  });

  it("does not extend another agent's token", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    // Token belongs to Alice's attachment...
    const aliceAtt = await seedAttachment(alice.id);
    const shortExpiry = new Date(Date.now() + 24 * HOUR * 1000);
    const { url, tokenId } = await seedToken(aliceAtt, {
      expiresAt: shortExpiry,
    });

    // ...but Bob references its URL in his pane. The owner filter must keep
    // Bob from extending the lifetime of a capability URL he doesn't own.
    const res = await createPane(bob.apiKey, { hero: url }, YEAR_S);
    expect(res.status).toBe(201);

    const tok = await prisma.attachmentToken.findUnique({
      where: { id: tokenId },
    });
    expect(tok!.expiresAt.getTime()).toBe(shortExpiry.getTime());
  });

  it("extends multiple referenced tokens in one create", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const att1 = await seedAttachment(agentId);
    const att2 = await seedAttachment(agentId);
    const shortExpiry = new Date(Date.now() + 24 * HOUR * 1000);
    const t1 = await seedToken(att1, { expiresAt: shortExpiry });
    const t2 = await seedToken(att2, { expiresAt: shortExpiry });

    const res = await createPane(
      apiKey,
      { gallery: [{ src: t1.url }, { src: t2.url }] },
      YEAR_S,
    );
    expect(res.status).toBe(201);
    const { expires_at } = (await res.json()) as { expires_at: string };
    const paneExpiry = new Date(expires_at).getTime();

    for (const id of [t1.tokenId, t2.tokenId]) {
      const tok = await prisma.attachmentToken.findUnique({ where: { id } });
      expect(tok!.expiresAt.getTime()).toBe(paneExpiry);
    }
  });

  it("creates the pane normally when input_data has no token URLs", async () => {
    const { apiKey } = await seedAgent();
    const res = await createPane(apiKey, { note: "no tokens here" }, YEAR_S);
    expect(res.status).toBe(201);
  });
});
