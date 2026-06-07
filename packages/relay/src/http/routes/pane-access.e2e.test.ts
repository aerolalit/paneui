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
  it("public mode opens anonymously and mints an EMIT-CAPABLE ticket", async () => {
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

    // Public is "view + participate": an anonymous visitor now gets a ws-ticket
    // (was 403) so they can connect AND emit. The emit capability itself is
    // asserted at the WS layer (handler.e2e.test.ts); here we assert the mint
    // succeeds and a shared guest participant is lazily created.
    const ticket = await app.fetch(
      new Request(`http://t/p/${paneId}/ws-ticket`, { method: "POST" }),
    );
    expect(ticket.status).toBe(201);
    const body = (await ticket.json()) as { ticket?: string };
    expect(typeof body.ticket).toBe("string");

    const guest = await prisma.participant.findFirst({
      where: { paneId, identityId: "h_public" },
    });
    expect(guest).not.toBeNull();
    expect(guest?.humanId).toBeNull();
  });

  it("link mode opens anonymously and mints a RECEIVE-ONLY ticket", async () => {
    // The new behaviour: `link` (the default) opens /p with no login. A
    // read-only viewer must still RECEIVE replay/live updates, so they now get
    // a ws-ticket too (was 403) — but it is receive-only (canEmit:false). The
    // receive-only enforcement is asserted at the WS layer.
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

    // No longer 403 — a read-only viewer needs the socket to receive content.
    const ticket = await app.fetch(
      new Request(`http://t/p/${paneId}/ws-ticket`, { method: "POST" }),
    );
    expect(ticket.status).toBe(201);
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

  it("invite_only: viewer grant is read-only but gets a receive-only ticket", async () => {
    // A viewer grant can now connect (to RECEIVE replay/live updates) — so the
    // ws-ticket mint succeeds (was 403). The ticket is receive-only; the emit
    // rejection is enforced at the WS layer (handler.e2e.test.ts).
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
    expect(ticket.status).toBe(201);
  });

  it("invite_only non-grantee still gets 404 on ws-ticket (no oracle)", async () => {
    const owner = await seedHumanWithCookie("owner@example.com");
    const { paneId } = await seedPane(owner.humanId);
    await prisma.pane.update({
      where: { id: paneId },
      data: { accessMode: "invite_only" },
    });
    const stranger = await seedHumanWithCookie("stranger@example.com");

    const ticket = await app.fetch(
      new Request(`http://t/p/${paneId}/ws-ticket`, {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${stranger.cookie}` },
      }),
    );
    expect(ticket.status).toBe(404);
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

  it("Share affordance on /p is owner-only — present for owner, absent for grantee", async () => {
    // The account bar renders for any logged-in human on /p/:paneId, but the
    // Share button (and dialog) must be gated on pane ownership: a participant
    // grantee can use the pane but cannot manage its sharing.
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

    // Owner: account bar carries the Share button + dialog.
    const ownerShell = await app.fetch(
      new Request(`http://t/p/${paneId}`, {
        headers: cookieHeaders(owner.cookie),
      }),
    );
    const ownerHtml = await ownerShell.text();
    expect(ownerHtml).toContain('id="top-nav-share"');
    expect(ownerHtml).toContain('id="share-modal"');
    expect(ownerHtml).toContain('id="top-nav-signout"');

    // Grantee: still gets the account bar (Sign out) but NO Share affordance.
    const granteeShell = await app.fetch(
      new Request(`http://t/p/${paneId}`, {
        headers: cookieHeaders(bob.cookie),
      }),
    );
    const granteeHtml = await granteeShell.text();
    expect(granteeHtml).toContain('id="top-nav-signout"');
    expect(granteeHtml).not.toContain('id="top-nav-share"');
    expect(granteeHtml).not.toContain('id="share-modal"');
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
