// End-to-end tests for /v1/auth/* — the magic-link login flow.
//
// Uses the `dev` email provider, which captures the magic link in the
// logger output. Tests reach into the test DB to read the MagicLink row
// directly when they need to verify storage shape (token-hash invariant,
// expiry, etc.); the request-link → verify → cookie flow is exercised
// through the real HTTP pane.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import { makeNoneProvider } from "../../auth/providers/none.js";
import { makeDevProvider } from "../../auth/providers/dev.js";
import {
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
  parseLoginCookie,
} from "../../auth/cookie.js";
import { hashMagicLinkToken } from "../../auth/magic-link.js";

let testDb: TestDb;
let prisma: PrismaClient;
let appWithDev: Hono;
let appWithNone: Hono;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);

  const baseConfig = {
    DATABASE_URL: testDb.dbUrl,
    PUBLIC_URL: "http://localhost:3000",
  };
  appWithDev = buildApp(
    loadConfig({ ...baseConfig, EMAIL_PROVIDER: "dev" }),
    prisma,
    undefined,
    undefined,
    undefined,
    makeDevProvider({ isProduction: false }),
  );
  appWithNone = buildApp(
    loadConfig(baseConfig),
    prisma,
    undefined,
    undefined,
    undefined,
    makeNoneProvider(),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

describe("GET /v1/auth/status", () => {
  it("reports available=true on a dev-provider relay", async () => {
    const res = await appWithDev.fetch(new Request("http://t/v1/auth/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; provider: string };
    expect(body).toEqual({ available: true, provider: "dev" });
  });

  it("reports available=false when EMAIL_PROVIDER=none", async () => {
    const res = await appWithNone.fetch(new Request("http://t/v1/auth/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; provider: string };
    expect(body).toEqual({ available: false, provider: "none" });
  });
});

describe("POST /v1/auth/request-link", () => {
  it("returns 503 when EMAIL_PROVIDER=none", async () => {
    const res = await appWithNone.fetch(
      new Request("http://t/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com" }),
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_provider_unavailable");
  });

  it("rejects a malformed body with 400 invalid_request", async () => {
    const res = await appWithDev.fetch(
      new Request("http://t/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notAnEmail: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a MagicLink row and returns 202 on a valid request", async () => {
    const before = await prisma.magicLink.count();
    const res = await appWithDev.fetch(
      new Request("http://t/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "Alice@Example.com" }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; expires_at: string };
    expect(body.ok).toBe(true);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    const after = await prisma.magicLink.count();
    expect(after).toBe(before + 1);
  });

  it("normalises the email address before storing", async () => {
    await appWithDev.fetch(
      new Request("http://t/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "  Alice@Example.COM  " }),
      }),
    );
    const link = await prisma.magicLink.findFirst({});
    expect(link?.email).toBe("alice@example.com");
  });
});

async function mintLink(
  email: string,
  opts: { returnUrl?: string; ttlMs?: number } = {},
): Promise<{ raw: string; tokenHash: string }> {
  const { generateMagicLinkToken } = await import("../../auth/magic-link.js");
  const raw = generateMagicLinkToken();
  const tokenHash = hashMagicLinkToken(raw);
  await prisma.magicLink.create({
    data: {
      email,
      tokenHash,
      expiresAt: new Date(Date.now() + (opts.ttlMs ?? 60_000)),
      returnUrl: opts.returnUrl,
    },
  });
  return { raw, tokenHash };
}

describe("GET /v1/auth/verify", () => {
  it("returns 400 for a missing token", async () => {
    const res = await appWithDev.fetch(new Request("http://t/v1/auth/verify"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown token", async () => {
    const res = await appWithDev.fetch(
      new Request("http://t/v1/auth/verify?token=ml_unknown_123456"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_token");
  });

  it("returns 400 for an expired token", async () => {
    const { raw } = await mintLink("alice@example.com", { ttlMs: -1000 });
    const res = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`),
    );
    expect(res.status).toBe(400);
  });

  it("on success: creates Human + Login, sets cookie, redirects 303", async () => {
    const { raw, tokenHash } = await mintLink("alice@example.com");
    const res = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(303);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(LOGIN_COOKIE_NAME);

    // MagicLink consumed
    const link = await prisma.magicLink.findUnique({ where: { tokenHash } });
    expect(link?.consumedAt).not.toBeNull();

    // Human created with verifiedAt set
    const human = await prisma.human.findUnique({
      where: { email: "alice@example.com" },
    });
    expect(human).not.toBeNull();
    expect(human?.verifiedAt).not.toBeNull();

    // Login created bound to that human, cookie stored hashed
    const cookieValue = parseLoginCookie(setCookie);
    expect(cookieValue).not.toBeNull();
    const login = await prisma.login.findUnique({
      where: { cookieHash: hashLoginCookie(cookieValue!) },
    });
    expect(login?.humanId).toBe(human?.id);
  });

  it("does not bump verifiedAt on subsequent logins for the same human", async () => {
    // First login
    const first = await mintLink("alice@example.com");
    await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${first.raw}`, {
        redirect: "manual",
      }),
    );
    const human1 = await prisma.human.findUnique({
      where: { email: "alice@example.com" },
    });
    const firstVerifiedAt = human1!.verifiedAt!;

    // Wait a tick + second login
    await new Promise((r) => setTimeout(r, 30));
    const second = await mintLink("alice@example.com");
    await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${second.raw}`, {
        redirect: "manual",
      }),
    );
    const human2 = await prisma.human.findUnique({
      where: { email: "alice@example.com" },
    });
    expect(human2?.verifiedAt?.getTime()).toBe(firstVerifiedAt.getTime());
  });

  it("rejects an already-consumed token (one-shot)", async () => {
    const { raw } = await mintLink("alice@example.com");
    const ok = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    expect(ok.status).toBe(303);
    const replay = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    expect(replay.status).toBe(400);
  });

  it("honors a same-origin returnUrl", async () => {
    const { raw } = await mintLink("alice@example.com", {
      returnUrl: "http://localhost:3000/home",
    });
    const res = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    expect(res.headers.get("location")).toBe("/home");
  });

  it("ignores a cross-origin returnUrl (open-redirect defence)", async () => {
    const { raw } = await mintLink("alice@example.com", {
      returnUrl: "https://evil.example.com/steal-cookie",
    });
    const res = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    // Open-redirect defence: a cross-origin returnUrl is dropped and the
    // default landing (/home, per Phase D) is used instead.
    expect(res.headers.get("location")).toBe("/home");
  });
});

describe("POST /v1/auth/logout", () => {
  it("clears the cookie and revokes the Login row", async () => {
    // Establish a login by completing a verify cycle
    const { raw } = await mintLink("alice@example.com");
    const verifyRes = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    const setCookie = verifyRes.headers.get("set-cookie")!;
    const cookieValue = parseLoginCookie(setCookie)!;

    const beforeLogins = await prisma.login.count();
    expect(beforeLogins).toBe(1);

    const logoutRes = await appWithDev.fetch(
      new Request("http://t/v1/auth/logout", {
        method: "POST",
        headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookieValue}` },
      }),
    );
    expect(logoutRes.status).toBe(204);
    expect(logoutRes.headers.get("set-cookie")).toContain("Max-Age=0");

    const afterLogins = await prisma.login.count();
    expect(afterLogins).toBe(0);
  });

  it("is idempotent on a missing cookie", async () => {
    const res = await appWithDev.fetch(
      new Request("http://t/v1/auth/logout", { method: "POST" }),
    );
    expect(res.status).toBe(204);
  });
});
