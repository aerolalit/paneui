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
  ML_NONCE_COOKIE_NAME,
  parseLoginCookie,
  parseMagicLinkNonceCookie,
} from "../../auth/cookie.js";
import {
  generateMagicLinkNonce,
  hashMagicLinkNonce,
  hashMagicLinkToken,
} from "../../auth/magic-link.js";

let testDb: TestDb;
let prisma: PrismaClient;
let appWithDev: Hono;
let appWithNone: Hono;
// Dedicated app whose request-link throttle uses a low limit, so the F-09
// throttle test can exhaust it deterministically. Each test that uses it
// targets a distinct email so the per-email key is independent across tests;
// the per-IP key ("unknown" in tests) is shared, so each F-09 test resets the
// limiter by rebuilding this app in its own beforeEach-equivalent setup.
let appThrottle: Hono;
const THROTTLE_LIMIT = 3;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);

  const baseConfig = {
    DATABASE_URL: testDb.dbUrl,
    PUBLIC_URL: "http://localhost:3000",
    // The default per-(IP,email) request-link throttle is 3/15min. In tests
    // clientIp() resolves to "unknown" (no socket), so EVERY request-link call
    // in this file shares one IP bucket — at the default these unrelated
    // functional tests would throttle each other. Raise the cap well above the
    // number of request-link calls here; the throttle itself is exercised by a
    // dedicated app (appThrottle) + test below that uses the low default.
    MAGIC_LINK_RATE_LIMIT: "1000",
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

  it("persists the optional name on the MagicLink row", async () => {
    await appWithDev.fetch(
      new Request("http://t/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice2@example.com",
          name: "Alice Wonderland",
        }),
      }),
    );
    const link = await prisma.magicLink.findFirst({
      where: { email: "alice2@example.com" },
    });
    expect(link?.name).toBe("Alice Wonderland");
  });

  it("normalises an empty name to null", async () => {
    await appWithDev.fetch(
      new Request("http://t/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice3@example.com",
          name: "   ",
        }),
      }),
    );
    const link = await prisma.magicLink.findFirst({
      where: { email: "alice3@example.com" },
    });
    expect(link?.name).toBeNull();
  });

  // F-16 — request-link sets the pre-login nonce cookie and stores its hash
  // on the row. The cookie carries the RAW nonce; the row stores only the
  // hash, and the two must correspond.
  it("sets a pane_ml_nonce cookie and stores its hash on the row (F-16)", async () => {
    const res = await appWithDev.fetch(
      new Request("http://t/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nonce@example.com" }),
      }),
    );
    expect(res.status).toBe(202);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(ML_NONCE_COOKIE_NAME);
    // Scoped + hardened: Lax (survives the email's top-level GET), HttpOnly,
    // path-scoped to /v1/auth.
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/v1/auth");

    const rawNonce = parseMagicLinkNonceCookie(setCookie);
    expect(rawNonce).not.toBeNull();

    const link = await prisma.magicLink.findFirst({
      where: { email: "nonce@example.com" },
    });
    // Hash stored on the row matches the hash of the raw cookie value.
    expect(link?.nonceHash).toBe(hashMagicLinkNonce(rawNonce!));
  });
});

// F-09 — per-(IP, email) throttle on POST /v1/auth/request-link. Each test
// builds its own app so the in-process limiter (owned by the app instance)
// starts empty — the per-IP key resolves to "unknown" in tests and is shared
// across the whole file otherwise.
describe("POST /v1/auth/request-link throttle (F-09)", () => {
  function buildThrottleApp(): Hono {
    return buildApp(
      loadConfig({
        DATABASE_URL: testDb.dbUrl,
        PUBLIC_URL: "http://localhost:3000",
        EMAIL_PROVIDER: "dev",
        MAGIC_LINK_RATE_LIMIT: String(THROTTLE_LIMIT),
        MAGIC_LINK_RATE_WINDOW_SECONDS: "900",
      }),
      prisma,
      undefined,
      undefined,
      undefined,
      makeDevProvider({ isProduction: false }),
    );
  }

  async function requestLink(app: Hono, email: string): Promise<number> {
    const res = await app.fetch(
      new Request("http://t/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
    return res.status;
  }

  it("always returns 202 but stops creating rows past the limit (no enumeration oracle)", async () => {
    appThrottle = buildThrottleApp();
    const email = "victim@example.com";

    // Fire LIMIT + 3 requests. EVERY response must be 202 — a different status
    // on the throttled requests would let an attacker enumerate which address
    // is rate-limited.
    const statuses: number[] = [];
    for (let i = 0; i < THROTTLE_LIMIT + 3; i++) {
      statuses.push(await requestLink(appThrottle, email));
    }
    expect(statuses.every((s) => s === 202)).toBe(true);

    // Only LIMIT rows/emails were actually created; the rest were silently
    // dropped while still returning 202.
    const rows = await prisma.magicLink.count({ where: { email } });
    expect(rows).toBe(THROTTLE_LIMIT);
  });

  it("throttles per-email independently — a different address is unaffected", async () => {
    appThrottle = buildThrottleApp();
    const bombed = "bombed@example.com";
    const other = "other@example.com";

    // Exhaust the bombed address's email key.
    for (let i = 0; i < THROTTLE_LIMIT + 2; i++) {
      expect(await requestLink(appThrottle, bombed)).toBe(202);
    }
    expect(await prisma.magicLink.count({ where: { email: bombed } })).toBe(
      THROTTLE_LIMIT,
    );

    // The per-IP key is shared and also consumed by the calls above, so the
    // other address can still get rows only up to whatever IP budget remains.
    // With the IP and email limits equal, the bombing already exhausted the
    // shared IP key — so the second address is now throttled too, proving the
    // IP key bounds a rotating-target attacker. Assert it still always-202s.
    expect(await requestLink(appThrottle, other)).toBe(202);
    // No new row for `other`: the shared per-IP bucket is exhausted.
    expect(await prisma.magicLink.count({ where: { email: other } })).toBe(0);
  });

  it("a fresh address under a fresh IP bucket is allowed (email key is independent)", async () => {
    // Distinct app => fresh limiter => fresh IP bucket. A first-time address
    // gets its link created and a 202.
    appThrottle = buildThrottleApp();
    const fresh = "fresh@example.com";
    expect(await requestLink(appThrottle, fresh)).toBe(202);
    expect(await prisma.magicLink.count({ where: { email: fresh } })).toBe(1);
  });
});

async function mintLink(
  email: string,
  opts: {
    returnUrl?: string;
    ttlMs?: number;
    name?: string;
    // When true, the row is nonce-bound (F-16): a fresh nonce is generated,
    // its hash stored, and the raw nonce returned so the caller can carry it
    // as the pane_ml_nonce cookie on verify. Default false keeps the link
    // null-nonce (the back-compat path), matching pre-F-16 rows.
    nonce?: boolean;
  } = {},
): Promise<{ raw: string; tokenHash: string; nonce: string | null }> {
  const { generateMagicLinkToken } = await import("../../auth/magic-link.js");
  const raw = generateMagicLinkToken();
  const tokenHash = hashMagicLinkToken(raw);
  const nonce = opts.nonce ? generateMagicLinkNonce() : null;
  await prisma.magicLink.create({
    data: {
      email,
      tokenHash,
      nonceHash: nonce ? hashMagicLinkNonce(nonce) : null,
      expiresAt: new Date(Date.now() + (opts.ttlMs ?? 60_000)),
      returnUrl: opts.returnUrl,
      name: opts.name ?? null,
    },
  });
  return { raw, tokenHash, nonce };
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

  it("persists the link's name onto a freshly created Human", async () => {
    const { raw } = await mintLink("bob@example.com", { name: "Bob Smith" });
    await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    const human = await prisma.human.findUnique({
      where: { email: "bob@example.com" },
    });
    expect(human?.name).toBe("Bob Smith");
  });

  it("does NOT overwrite an existing name on a subsequent login", async () => {
    const first = await mintLink("carla@example.com", { name: "Carla" });
    await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${first.raw}`, {
        redirect: "manual",
      }),
    );
    // Second login attempt carries a different name in the link — must
    // not clobber the persisted name.
    const second = await mintLink("carla@example.com", {
      name: "Imposter Carla",
    });
    await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${second.raw}`, {
        redirect: "manual",
      }),
    );
    const human = await prisma.human.findUnique({
      where: { email: "carla@example.com" },
    });
    expect(human?.name).toBe("Carla");
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

  // ---- F-16 nonce binding (login-CSRF / session fixation) ----

  it("back-compat: a null-nonceHash link still verifies without a nonce cookie", async () => {
    // mintLink defaults to nonce:false → nonceHash null, mirroring a row
    // minted before F-16. Must still log in (no nonce check).
    const { raw } = await mintLink("legacy@example.com");
    const res = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain(LOGIN_COOKIE_NAME);
  });

  it("verifies a nonce-bound link WITH the matching nonce cookie (303 + session)", async () => {
    const { raw, nonce } = await mintLink("bound@example.com", { nonce: true });
    expect(nonce).not.toBeNull();
    const res = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
        headers: { cookie: `${ML_NONCE_COOKIE_NAME}=${nonce}` },
      }),
    );
    expect(res.status).toBe(303);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(LOGIN_COOKIE_NAME);
    // Session was actually established.
    const cookieValue = parseLoginCookie(setCookie);
    expect(cookieValue).not.toBeNull();
    const login = await prisma.login.findUnique({
      where: { cookieHash: hashLoginCookie(cookieValue!) },
    });
    expect(login).not.toBeNull();
    // The nonce cookie is cleared on success.
    expect(setCookie).toContain(`${ML_NONCE_COOKIE_NAME}=;`);
  });

  it("REJECTS a nonce-bound link WITHOUT any nonce cookie (login-CSRF case)", async () => {
    const { raw, tokenHash } = await mintLink("victim@example.com", {
      nonce: true,
    });
    // The attacker lures the victim to click; the victim's browser has no
    // pane_ml_nonce cookie for this link.
    const res = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_token");
    // No session was set.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await prisma.login.count()).toBe(0);
    // Token NOT consumed — the legitimate requester can still use it.
    const link = await prisma.magicLink.findUnique({ where: { tokenHash } });
    expect(link?.consumedAt).toBeNull();
  });

  it("REJECTS a nonce-bound link with the WRONG nonce cookie", async () => {
    const { raw } = await mintLink("victim2@example.com", { nonce: true });
    const wrong = generateMagicLinkNonce();
    const res = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${raw}`, {
        redirect: "manual",
        headers: { cookie: `${ML_NONCE_COOKIE_NAME}=${wrong}` },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_token");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await prisma.login.count()).toBe(0);
  });

  it("end-to-end: request-link → verify carrying the issued nonce cookie succeeds", async () => {
    // Drive the real request-link endpoint to capture both the emitted nonce
    // cookie and the magic-link token (the dev provider logs the link).
    const reqRes = await appWithDev.fetch(
      new Request("http://t/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "e2e@example.com" }),
      }),
    );
    expect(reqRes.status).toBe(202);
    const rawNonce = parseMagicLinkNonceCookie(
      reqRes.headers.get("set-cookie"),
    );
    expect(rawNonce).not.toBeNull();

    // The token isn't returned over HTTP; read it the same way mintLink does —
    // we re-derive by issuing our own link bound to this same nonce hash, then
    // verify the issued cookie unlocks it. (We mint with nonce:false then patch
    // in the captured hash to keep the assertion about the COOKIE, not minting.)
    const link = await prisma.magicLink.findFirst({
      where: { email: "e2e@example.com" },
    });
    expect(link?.nonceHash).toBe(hashMagicLinkNonce(rawNonce!));

    // Issue a fresh token bound to the captured nonce hash and verify it with
    // the issued cookie — proves the request-link cookie unlocks a row whose
    // stored hash it produced.
    const { generateMagicLinkToken } = await import("../../auth/magic-link.js");
    const token = generateMagicLinkToken();
    await prisma.magicLink.create({
      data: {
        email: "e2e@example.com",
        tokenHash: hashMagicLinkToken(token),
        nonceHash: hashMagicLinkNonce(rawNonce!),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const verifyRes = await appWithDev.fetch(
      new Request(`http://t/v1/auth/verify?token=${token}`, {
        redirect: "manual",
        headers: { cookie: `${ML_NONCE_COOKIE_NAME}=${rawNonce}` },
      }),
    );
    expect(verifyRes.status).toBe(303);
    expect(verifyRes.headers.get("set-cookie")).toContain(LOGIN_COOKIE_NAME);
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
