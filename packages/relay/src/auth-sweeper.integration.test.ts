// Integration test for the auth-state sweeper (#307). Mirrors the
// sweeper.integration.test.ts pattern: real DB, real Prisma, real time math.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "./test-helpers/db.js";

let testDb: TestDb;
let prisma: PrismaClient;
let sweepAuthTokens: typeof import("./auth-sweeper.js").sweepAuthTokens;
let authSweepIntervalSeconds: typeof import("./auth-sweeper.js").authSweepIntervalSeconds;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  const { createPrismaClient } = await import("./db.js");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  ({ sweepAuthTokens, authSweepIntervalSeconds } =
    await import("./auth-sweeper.js"));
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

async function seedHuman(email: string): Promise<string> {
  const h = await prisma.human.create({ data: { email } });
  return h.id;
}

async function seedLogin(humanId: string, expiresAt: Date): Promise<string> {
  const r = await prisma.login.create({
    data: {
      humanId,
      cookieHash: randomBytes(32).toString("hex"),
      expiresAt,
    },
  });
  return r.id;
}

async function seedMagicLink(opts: {
  expiresAt: Date;
  consumedAt?: Date | null;
}): Promise<string> {
  const r = await prisma.magicLink.create({
    data: {
      email: `user-${randomBytes(4).toString("hex")}@example.com`,
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: opts.expiresAt,
      consumedAt: opts.consumedAt ?? null,
    },
  });
  return r.id;
}

async function seedClaimCode(opts: {
  humanId: string;
  expiresAt: Date;
  consumedAt?: Date | null;
}): Promise<string> {
  const r = await prisma.claimCode.create({
    data: {
      humanId: opts.humanId,
      codeHash: randomBytes(32).toString("hex"),
      expiresAt: opts.expiresAt,
      consumedAt: opts.consumedAt ?? null,
    },
  });
  return r.id;
}

async function seedAttachmentTokenRow(opts: {
  expiresAt: Date;
  revokedAt?: Date | null;
}): Promise<string> {
  // attachment_tokens FK an Attachment; create a minimal attachment chain.
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: "pane_test",
    },
  });
  const att = await prisma.attachment.create({
    data: {
      ownerId: agent.id,
      scope: "agent",
      mime: "image/png",
      size: 100,
      sha256: "f".repeat(64),
      storageKey: `att_${randomBytes(8).toString("hex")}`,
      status: "ready",
    },
  });
  const tok = await prisma.attachmentToken.create({
    data: {
      attachmentId: att.id,
      tokenHash: randomBytes(32).toString("hex"),
      tokenPrefix: "tok_a_pre",
      expiresAt: opts.expiresAt,
      revokedAt: opts.revokedAt ?? null,
    },
  });
  return tok.id;
}

describe("sweepAuthTokens (integration, real DB)", () => {
  it("hard-deletes expired logins; preserves non-expired ones", async () => {
    const humanId = await seedHuman("a@example.com");
    const expired = await seedLogin(humanId, new Date(Date.now() - 1000));
    const live = await seedLogin(humanId, new Date(Date.now() + HOUR_MS));

    const r = await sweepAuthTokens(prisma);
    expect(r.logins).toBe(1);
    expect(
      await prisma.login.findUnique({ where: { id: expired } }),
    ).toBeNull();
    expect(
      await prisma.login.findUnique({ where: { id: live } }),
    ).not.toBeNull();
  });

  it("hard-deletes expired magic_links; preserves non-expired-and-unconsumed ones", async () => {
    const expired = await seedMagicLink({
      expiresAt: new Date(Date.now() - 1000),
    });
    const live = await seedMagicLink({
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    const r = await sweepAuthTokens(prisma);
    expect(r.magic_links).toBe(1);
    expect(
      await prisma.magicLink.findUnique({ where: { id: expired } }),
    ).toBeNull();
    expect(
      await prisma.magicLink.findUnique({ where: { id: live } }),
    ).not.toBeNull();
  });

  it("hard-deletes consumed-7d-old magic_links; preserves consumed-1h-old", async () => {
    // A magic link can still be in expires window but consumed long ago —
    // the consumed-grace predicate catches it.
    const oldConsumed = await seedMagicLink({
      expiresAt: new Date(Date.now() + HOUR_MS),
      consumedAt: new Date(Date.now() - 8 * DAY_MS),
    });
    const recentConsumed = await seedMagicLink({
      expiresAt: new Date(Date.now() + HOUR_MS),
      consumedAt: new Date(Date.now() - 1 * HOUR_MS),
    });

    const r = await sweepAuthTokens(prisma);
    expect(r.magic_links).toBe(1);
    expect(
      await prisma.magicLink.findUnique({ where: { id: oldConsumed } }),
    ).toBeNull();
    expect(
      await prisma.magicLink.findUnique({ where: { id: recentConsumed } }),
    ).not.toBeNull();
  });

  it("hard-deletes expired claim_codes; consumed-7d grace applies the same way", async () => {
    const humanId = await seedHuman("c@example.com");
    const expired = await seedClaimCode({
      humanId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const oldConsumed = await seedClaimCode({
      humanId,
      expiresAt: new Date(Date.now() + HOUR_MS),
      consumedAt: new Date(Date.now() - 8 * DAY_MS),
    });
    const live = await seedClaimCode({
      humanId,
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    const r = await sweepAuthTokens(prisma);
    expect(r.claim_codes).toBe(2);
    expect(
      await prisma.claimCode.findUnique({ where: { id: expired } }),
    ).toBeNull();
    expect(
      await prisma.claimCode.findUnique({ where: { id: oldConsumed } }),
    ).toBeNull();
    expect(
      await prisma.claimCode.findUnique({ where: { id: live } }),
    ).not.toBeNull();
  });

  it("hard-deletes expired attachment_tokens; revoked-7d grace applies", async () => {
    const expired = await seedAttachmentTokenRow({
      expiresAt: new Date(Date.now() - 1000),
    });
    const oldRevoked = await seedAttachmentTokenRow({
      expiresAt: new Date(Date.now() + HOUR_MS),
      revokedAt: new Date(Date.now() - 8 * DAY_MS),
    });
    const recentRevoked = await seedAttachmentTokenRow({
      expiresAt: new Date(Date.now() + HOUR_MS),
      revokedAt: new Date(Date.now() - 1 * HOUR_MS),
    });
    const live = await seedAttachmentTokenRow({
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    const r = await sweepAuthTokens(prisma);
    expect(r.attachment_tokens).toBe(2);
    expect(
      await prisma.attachmentToken.findUnique({ where: { id: expired } }),
    ).toBeNull();
    expect(
      await prisma.attachmentToken.findUnique({ where: { id: oldRevoked } }),
    ).toBeNull();
    expect(
      await prisma.attachmentToken.findUnique({
        where: { id: recentRevoked },
      }),
    ).not.toBeNull();
    expect(
      await prisma.attachmentToken.findUnique({ where: { id: live } }),
    ).not.toBeNull();
  });

  it("is a no-op when nothing matches the sweep predicates", async () => {
    const humanId = await seedHuman("d@example.com");
    await seedLogin(humanId, new Date(Date.now() + HOUR_MS));
    await seedMagicLink({ expiresAt: new Date(Date.now() + HOUR_MS) });

    const r = await sweepAuthTokens(prisma);
    expect(r).toEqual({
      logins: 0,
      magic_links: 0,
      claim_codes: 0,
      attachment_tokens: 0,
    });
  });

  it("is idempotent — second pass over the same expirations is 0", async () => {
    const humanId = await seedHuman("e@example.com");
    await seedLogin(humanId, new Date(Date.now() - 1000));
    const first = await sweepAuthTokens(prisma);
    expect(first.logins).toBe(1);
    const second = await sweepAuthTokens(prisma);
    expect(second.logins).toBe(0);
  });

  it("batches at 500 per table per pass; second pass picks up the rest", async () => {
    const humanId = await seedHuman("f@example.com");
    // 600 expired logins → first pass removes 500, second pass removes 100.
    const expiredAt = new Date(Date.now() - 1000);
    await prisma.login.createMany({
      data: Array.from({ length: 600 }, () => ({
        humanId,
        cookieHash: randomBytes(32).toString("hex"),
        expiresAt: expiredAt,
      })),
    });

    const first = await sweepAuthTokens(prisma);
    expect(first.logins).toBe(500);
    const second = await sweepAuthTokens(prisma);
    expect(second.logins).toBe(100);
  });
});

describe("authSweepIntervalSeconds", () => {
  // No beforeAll wiping process.env — these tests poke env explicitly.
  it("defaults to 3600 when HARD_DELETE_SWEEP_SECONDS is unset", () => {
    delete process.env.HARD_DELETE_SWEEP_SECONDS;
    expect(authSweepIntervalSeconds()).toBe(3600);
  });

  it("returns the parsed integer when set", () => {
    process.env.HARD_DELETE_SWEEP_SECONDS = "60";
    expect(authSweepIntervalSeconds()).toBe(60);
  });

  it("returns 0 (disables) when set to 0", () => {
    process.env.HARD_DELETE_SWEEP_SECONDS = "0";
    expect(authSweepIntervalSeconds()).toBe(0);
  });

  it("falls back to default on non-integer values (logs warn)", () => {
    process.env.HARD_DELETE_SWEEP_SECONDS = "abc";
    expect(authSweepIntervalSeconds()).toBe(3600);
  });

  it("falls back to default on negative values", () => {
    process.env.HARD_DELETE_SWEEP_SECONDS = "-1";
    expect(authSweepIntervalSeconds()).toBe(3600);
  });
});
