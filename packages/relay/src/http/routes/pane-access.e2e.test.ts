// End-to-end tests for /p/:paneId (the identity-share mount) plus the two
// cross-cutting behaviours that feed it:
//   - expired/revoked /s/:token → 302 /p/:paneId
//   - magic-link verify binds a pending PaneGrant to the human on first login
//
// Security focus: no existence oracle (logged-out → login redirect for any
// pane id; logged-in non-grantee → 404, never 403), public is read-only.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import {
  generateApiKey,
  hashKey,
  keyPrefix,
  generatePaneId,
  generateHumanParticipantToken,
} from "../../keys.js";
import {
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
} from "../../auth/cookie.js";
import { makeDevProvider } from "../../auth/providers/dev.js";

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
      // Needed so the magic-link verify path is enabled for the binding test.
      EMAIL_PROVIDER: "dev",
    }),
    prisma,
    undefined,
    undefined,
    undefined,
    makeDevProvider({ isProduction: false }),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

async function seedHumanWithCookie(
  email: string,
): Promise<{ humanId: string; cookie: string }> {
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

async function seedPane(ownerHumanId: string): Promise<{ paneId: string }> {
  const agentKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      keyHash: hashKey(agentKey),
      keyPrefix: keyPrefix(agentKey),
      name: "a",
      ownerHumanId,
      claimedAt: new Date(),
    },
  });
  const template = await prisma.template.create({
    data: {
      name: "T",
      ownerId: agent.id,
      slug: "t-" + randomBytes(4).toString("hex"),
    },
  });
  const tv = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>hi</p>",
      eventSchema: { events: {} },
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: generatePaneId(),
      agentId: agent.id,
      ownerHumanId,
      templateVersionId: tv.id,
      title: "Shared Pane",
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { paneId: pane.id };
}

function cookieHeaders(cookie: string): HeadersInit {
  return { cookie: `${LOGIN_COOKIE_NAME}=${cookie}`, accept: "text/html" };
}

describe("/p/:paneId resolver", () => {
  it("public mode opens anonymously (read-only)", async () => {
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);
    await prisma.pane.update({
      where: { id: paneId },
      data: { accessMode: "public" },
    });

    const res = await app.fetch(
      new Request(`http://t/p/${paneId}`, {
        headers: { accept: "text/html" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    // Read-only: the ws-ticket mint (the emit credential) is refused for an
    // anonymous viewer.
    const ticket = await app.fetch(
      new Request(`http://t/p/${paneId}/ws-ticket`, { method: "POST" }),
    );
    expect(ticket.status).toBe(403);
  });

  it("link mode opens anonymously for a stranger (read-only)", async () => {
    // The new behaviour: `link` (the default) opens /p with no login — same
    // resolver outcome as public; only discovery (a follow-up) differs.
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);
    // Sanity: a freshly seeded pane defaults to `link`.
    const fresh = await prisma.pane.findUniqueOrThrow({
      where: { id: paneId },
      select: { accessMode: true },
    });
    expect(fresh.accessMode).toBe("link");

    const res = await app.fetch(
      new Request(`http://t/p/${paneId}`, {
        headers: { accept: "text/html" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    // Read-only: an anonymous link-mode viewer cannot mint a ws-ticket.
    const ticket = await app.fetch(
      new Request(`http://t/p/${paneId}/ws-ticket`, { method: "POST" }),
    );
    expect(ticket.status).toBe(403);
  });

  it("invite_only mode: logged-out browser → login redirect", async () => {
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);
    await prisma.pane.update({
      where: { id: paneId },
      data: { accessMode: "invite_only" },
    });

    const res = await app.fetch(
      new Request(`http://t/p/${paneId}`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?return=");
  });

  it("logged-out → login redirect is identical for a non-existent pane (no oracle)", async () => {
    const res = await app.fetch(
      new Request(`http://t/p/pan_doesnotexist123`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?return=");
  });

  it("invite_only: logged-in non-grantee → 404 (NOT 403, no existence leak)", async () => {
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);
    await prisma.pane.update({
      where: { id: paneId },
      data: { accessMode: "invite_only" },
    });
    const stranger = await seedHumanWithCookie("stranger@example.com");

    const res = await app.fetch(
      new Request(`http://t/p/${paneId}`, {
        headers: cookieHeaders(stranger.cookie),
      }),
    );
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("invite_only: invited human → opens with their role; participant grant can emit", async () => {
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);
    await prisma.pane.update({
      where: { id: paneId },
      data: { accessMode: "invite_only" },
    });
    const bob = await seedHumanWithCookie("bob@example.com");
    await prisma.paneGrant.create({
      data: {
        paneId,
        humanId: bob.humanId,
        inviteEmail: "bob@example.com",
        role: "participant",
        invitedBy: owner.humanId,
        acceptedAt: new Date(),
      },
    });

    const res = await app.fetch(
      new Request(`http://t/p/${paneId}`, {
        headers: cookieHeaders(bob.cookie),
      }),
    );
    expect(res.status).toBe(200);

    // participant role → ws-ticket mint succeeds (emit-capable).
    const ticket = await app.fetch(
      new Request(`http://t/p/${paneId}/ws-ticket`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${bob.cookie}` },
      }),
    );
    expect(ticket.status).toBe(201);
  });

  it("invite_only: viewer grant is read-only (ws-ticket refused)", async () => {
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);
    await prisma.pane.update({
      where: { id: paneId },
      data: { accessMode: "invite_only" },
    });
    const viewer = await seedHumanWithCookie("viewer@example.com");
    await prisma.paneGrant.create({
      data: {
        paneId,
        humanId: viewer.humanId,
        inviteEmail: "viewer@example.com",
        role: "viewer",
        invitedBy: owner.humanId,
        acceptedAt: new Date(),
      },
    });

    const shell = await app.fetch(
      new Request(`http://t/p/${paneId}`, {
        headers: cookieHeaders(viewer.cookie),
      }),
    );
    expect(shell.status).toBe(200);

    const ticket = await app.fetch(
      new Request(`http://t/p/${paneId}/ws-ticket`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${viewer.cookie}` },
      }),
    );
    expect(ticket.status).toBe(403);
  });

  it("invite_only: owner can open via /p and emit", async () => {
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);
    await prisma.pane.update({
      where: { id: paneId },
      data: { accessMode: "invite_only" },
    });
    const ticket = await app.fetch(
      new Request(`http://t/p/${paneId}/ws-ticket`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${owner.cookie}` },
      }),
    );
    expect(ticket.status).toBe(201);
  });
});

describe("expired/revoked /s/:token → 302 /p/:paneId", () => {
  it("a revoked participant token redirects to /p/:paneId for a browser", async () => {
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);
    const token = generateHumanParticipantToken();
    await prisma.participant.create({
      data: {
        paneId,
        kind: "human",
        identityId: "h_0",
        tokenHash: hashKey(token),
        tokenPrefix: keyPrefix(token),
        revokedAt: new Date(), // revoked
      },
    });

    const res = await app.fetch(
      new Request(`http://t/s/${token}`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/p/${paneId}`);
  });

  it("a fully-unknown token still 404s (no recovery, no crash)", async () => {
    const res = await app.fetch(
      new Request(`http://t/s/tok_h_${"a".repeat(43)}`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("magic-link verify binds a pending grant", () => {
  it("sets humanId + acceptedAt on the invitee's first login", async () => {
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);

    // Owner invites bob — pending grant (no humanId yet, no Human row yet).
    const grant = await prisma.paneGrant.create({
      data: {
        paneId,
        inviteEmail: "bob@example.com",
        role: "participant",
        invitedBy: owner.humanId,
      },
    });
    expect(grant.humanId).toBeNull();

    // Mint a magic link for bob and verify it (his first login).
    const { generateMagicLinkToken, hashMagicLinkToken } =
      await import("../../auth/magic-link.js");
    const raw = generateMagicLinkToken();
    await prisma.magicLink.create({
      data: {
        email: "bob@example.com",
        tokenHash: hashMagicLinkToken(raw),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const res = await app.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    // 303 redirect on successful verify.
    expect([302, 303]).toContain(res.status);

    const bound = await prisma.paneGrant.findUnique({
      where: { id: grant.id },
    });
    expect(bound?.humanId).not.toBeNull();
    expect(bound?.acceptedAt).not.toBeNull();
    const bob = await prisma.human.findUnique({
      where: { email: "bob@example.com" },
    });
    expect(bound?.humanId).toBe(bob?.id);
  });
});
