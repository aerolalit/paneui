// End-to-end tests for Phase E — human-authenticated participant mints.
//
// Covers:
//   POST /v1/surfaces/:id/identity-link   (identity-bound human, §7.3 A)
//   POST /v1/surfaces/:id/public-link    (anonymous capability, §7.3 B)
//   Bridge auth — identity-bound tokens redirect to /login when no cookie,
//                 403 wrong_account when cookie is for a different human.

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

async function seedLoggedInHuman(email = "alice@example.com"): Promise<{
  humanId: string;
  cookie: string;
}> {
  const human = await prisma.human.create({
    data: { email, verifiedAt: new Date() },
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

async function seedAgentOwnedSurface(humanId: string): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      name: "claimed",
      keyHash: "y".repeat(64),
      keyPrefix: "y",
      ownerHumanId: humanId,
      claimedAt: new Date(),
    },
  });
  const tmpl = await prisma.template.create({
    data: { ownerId: agent.id, name: "t" },
  });
  const tv = await prisma.templateVersion.create({
    data: {
      templateId: tmpl.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>hi</p>",
    },
  });
  const surface = await prisma.surface.create({
    data: {
      id: `ses_${randomBytes(6).toString("hex")}`,
      agentId: agent.id,
      ownerHumanId: humanId,
      templateVersionId: tv.id,
      title: "test",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return surface.id;
}

function withCookie(cookie: string): { cookie: string } {
  return { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` };
}

describe("POST /v1/surfaces/:id/identity-link", () => {
  it("requires a login cookie", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/surfaces/ses_x/identity-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-owners with 404 (no oracle)", async () => {
    const { humanId } = await seedLoggedInHuman();
    const surfaceId = await seedAgentOwnedSurface(humanId);
    // Different human, not owner
    const other = await seedLoggedInHuman("eve@example.com");
    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/identity-link`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...withCookie(other.cookie),
        },
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("creates the human + identity-bound participant", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const surfaceId = await seedAgentOwnedSurface(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/identity-link`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({ email: "  Bob@Example.COM  " }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      participant_id: string;
      kind: string;
      identity: { email: string };
      token: string;
      url: string;
    };
    expect(body.identity.email).toBe("bob@example.com");
    expect(body.token).toMatch(/^tok_h_/);
    expect(body.url).toContain("/s/");

    const target = await prisma.human.findUnique({
      where: { email: "bob@example.com" },
    });
    expect(target).not.toBeNull();
    expect(target?.verifiedAt).toBeNull(); // unverified until bob logs in

    const participant = await prisma.participant.findUnique({
      where: { id: body.participant_id },
    });
    expect(participant?.humanId).toBe(target?.id);
    expect(participant?.surfaceId).toBe(surfaceId);
  });

  it("rejects malformed email", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const surfaceId = await seedAgentOwnedSurface(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/identity-link`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({ email: "not-an-email" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/surfaces/:id/public-link", () => {
  it("requires a login cookie", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/surfaces/ses_x/public-link", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("creates an anonymous capability participant (humanId null)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const surfaceId = await seedAgentOwnedSurface(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/public-link`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      participant_id: string;
      kind: string;
      token: string;
      url: string;
    };
    expect(body.kind).toBe("human");
    expect(body.token).toMatch(/^tok_h_/);

    const participant = await prisma.participant.findUnique({
      where: { id: body.participant_id },
    });
    expect(participant?.humanId).toBeNull();
    expect(participant?.agentId).toBeNull();
  });
});

describe("bridge auth — identity-bound participants (§4.6)", () => {
  it("anonymous capability tokens still work without a cookie", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const surfaceId = await seedAgentOwnedSurface(humanId);
    const linkRes = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/public-link`, {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    const { token } = (await linkRes.json()) as { token: string };

    const bridgeRes = await app.fetch(
      new Request(`http://t/s/${token}`, { redirect: "manual" }),
    );
    expect(bridgeRes.status).toBe(200);
  });

  it("identity-bound tokens redirect to /login when no cookie", async () => {
    const { humanId, cookie: aliceCookie } = await seedLoggedInHuman();
    const surfaceId = await seedAgentOwnedSurface(humanId);
    const inviteRes = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/identity-link`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...withCookie(aliceCookie),
        },
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
    );
    const { token } = (await inviteRes.json()) as { token: string };

    // Bob hits the link with no cookie
    const bridgeRes = await app.fetch(
      new Request(`http://t/s/${token}`, { redirect: "manual" }),
    );
    expect(bridgeRes.status).toBe(302);
    expect(bridgeRes.headers.get("location")).toMatch(/^\/login\?return=/);
  });

  it("identity-bound tokens return 403 wrong_account on cookie mismatch", async () => {
    const { humanId, cookie: aliceCookie } = await seedLoggedInHuman();
    const surfaceId = await seedAgentOwnedSurface(humanId);
    const inviteRes = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/identity-link`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...withCookie(aliceCookie),
        },
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
    );
    const { token } = (await inviteRes.json()) as { token: string };

    // Someone ELSE (Eve) hits the link with their own valid cookie
    const eve = await seedLoggedInHuman("eve@example.com");
    const bridgeRes = await app.fetch(
      new Request(`http://t/s/${token}`, {
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${eve.cookie}` },
        redirect: "manual",
      }),
    );
    expect(bridgeRes.status).toBe(403);
    const body = (await bridgeRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe("wrong_account");
  });

  it("identity-bound tokens succeed on cookie match", async () => {
    const { humanId, cookie: aliceCookie } = await seedLoggedInHuman();
    const surfaceId = await seedAgentOwnedSurface(humanId);

    // Alice invites bob; verify Bob can access by logging in as bob
    const inviteRes = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/identity-link`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...withCookie(aliceCookie),
        },
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
    );
    const { token } = (await inviteRes.json()) as { token: string };

    // Bob's account already exists from the invite; seed a login for him.
    const bob = await prisma.human.findUnique({
      where: { email: "bob@example.com" },
    });
    const bobCookie = generateLoginCookie();
    await prisma.login.create({
      data: {
        humanId: bob!.id,
        cookieHash: hashLoginCookie(bobCookie),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const bridgeRes = await app.fetch(
      new Request(`http://t/s/${token}`, {
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${bobCookie}` },
        redirect: "manual",
      }),
    );
    expect(bridgeRes.status).toBe(200);
  });
});
