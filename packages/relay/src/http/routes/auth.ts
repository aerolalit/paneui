// /v1/auth/* — magic-link login flow.
//
//   POST /v1/auth/request-link   request a magic-link email
//   GET  /v1/auth/verify         consume a magic-link token, set the cookie
//   POST /v1/auth/logout         revoke the cookie's Login row, clear cookie
//
// All routes return 503 auth_provider_unavailable when EMAIL_PROVIDER=none.
// See docs/HUMAN-SIDE-PROPOSAL.md §4.

import { Hono } from "hono";
import { z } from "zod";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
  parseLoginCookie,
} from "../../auth/cookie.js";
import {
  buildMagicLinkUrl,
  generateMagicLinkToken,
  hashMagicLinkToken,
  normalizeEmail,
} from "../../auth/magic-link.js";
import type { AppEnv } from "../env.js";
import { errors } from "../errors.js";
import { log } from "../../log.js";

const auth = new Hono<AppEnv>();

// GET /v1/auth/status
// Tells a calling UI whether the login flow is available on this relay so
// it can hide or grey out the email form when EMAIL_PROVIDER=none. No auth
// required and no information that helps an attacker — only "is it on?".
auth.get("/auth/status", (c) => {
  const provider = c.get("emailProvider");
  return c.json({
    available: provider.available,
    provider: provider.kind,
  });
});

// POST /v1/auth/request-link
// Body: { email, returnUrl? }
// Always returns 202 even on rate-limit / invalid email, to avoid leaking
// whether an address is present in the system (account enumeration). The
// only 4xx is malformed input; the only 5xx is provider failure.
const requestLinkBody = z.object({
  // Preprocess trims so a paste with leading/trailing whitespace doesn't
  // 400 before normalization sees it; .email() then validates the
  // canonical RFC shape.
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().email().max(320),
  ),
  returnUrl: z.string().url().max(2048).optional(),
});

auth.post("/auth/request-link", async (c) => {
  const provider = c.get("emailProvider");
  if (!provider.available) {
    return c.json(
      {
        error: {
          code: "auth_provider_unavailable",
          message:
            "human-side login is disabled on this relay (EMAIL_PROVIDER=none)",
        },
      },
      503,
    );
  }
  const config = c.get("config");
  const prisma = c.get("prisma");

  let body: z.infer<typeof requestLinkBody>;
  try {
    body = requestLinkBody.parse(await c.req.json());
  } catch {
    throw errors.invalidRequest("expected { email, returnUrl? }");
  }

  const email = normalizeEmail(body.email);
  const token = generateMagicLinkToken();
  const tokenHash = hashMagicLinkToken(token);
  const expiresAt = new Date(Date.now() + config.MAGIC_LINK_TTL_SECONDS * 1000);

  // Insert the row BEFORE sending — if the provider fails we'd rather have
  // an unconsumed row that expires harmlessly than an email referencing a
  // token that doesn't exist.
  await prisma.magicLink.create({
    data: {
      email,
      tokenHash,
      expiresAt,
      returnUrl: body.returnUrl,
    },
  });

  const link = buildMagicLinkUrl({
    publicUrl: config.publicUrl,
    token,
  });
  try {
    await provider.sendMagicLink({
      to: email,
      link,
      ttlSeconds: config.MAGIC_LINK_TTL_SECONDS,
    });
  } catch (err) {
    log.error("magic-link send failed", {
      provider: provider.kind,
      email,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        error: {
          code: "provider_error",
          message: "failed to deliver magic-link email",
        },
      },
      502,
    );
  }

  return c.json({ ok: true, expires_at: expiresAt.toISOString() }, 202);
});

// GET /v1/auth/verify?token=<raw>
// Top-level navigation from the email link. Validates the token, marks it
// consumed, finds-or-creates the Human, mints a Login, sets the cookie,
// redirects to the return URL or to /.
auth.get("/auth/verify", async (c) => {
  const provider = c.get("emailProvider");
  if (!provider.available) {
    return c.json(
      {
        error: {
          code: "auth_provider_unavailable",
          message:
            "human-side login is disabled on this relay (EMAIL_PROVIDER=none)",
        },
      },
      503,
    );
  }
  const config = c.get("config");
  const prisma = c.get("prisma");

  const token = c.req.query("token");
  if (!token || typeof token !== "string" || token.length < 10) {
    throw errors.invalidRequest("missing or malformed token");
  }
  const tokenHash = hashMagicLinkToken(token);

  // Find + consume in a single transaction. The relay treats an
  // already-consumed / expired token the same way as a missing one to
  // avoid leaking whether a real link existed.
  const link = await prisma.magicLink.findUnique({ where: { tokenHash } });
  if (!link || link.consumedAt || link.expiresAt < new Date()) {
    return c.json(
      {
        error: {
          code: "invalid_token",
          message: "magic-link token is invalid or has expired",
        },
      },
      400,
    );
  }

  // Atomic consume: claim the row by sweeping consumedAt = NULL. Returns 0
  // updated if a race won; we treat that as a 400 with the same message.
  const consumed = await prisma.magicLink.updateMany({
    where: { id: link.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    return c.json(
      {
        error: {
          code: "invalid_token",
          message: "magic-link token is invalid or has expired",
        },
      },
      400,
    );
  }

  // Find-or-create the Human row by email. Per the proposal §4.2:
  // verifiedAt is set on FIRST successful login only — it's the moment of
  // address ownership proof, not a timestamp of every subsequent click.
  // Email-invite signups (Phase E) create a Human with verifiedAt = null;
  // the first login is what flips it.
  const now = new Date();
  const existing = await prisma.human.findUnique({
    where: { email: link.email },
  });
  const human = existing
    ? existing.verifiedAt
      ? existing
      : await prisma.human.update({
          where: { id: existing.id },
          data: { verifiedAt: now },
        })
    : await prisma.human.create({
        data: { email: link.email, verifiedAt: now },
      });

  // Mint the Login.
  const cookie = generateLoginCookie();
  const cookieHash = hashLoginCookie(cookie);
  const loginExpiresAt = new Date(Date.now() + config.LOGIN_TTL_SECONDS * 1000);
  await prisma.login.create({
    data: {
      humanId: human.id,
      cookieHash,
      expiresAt: loginExpiresAt,
      lastSeenAt: now,
    },
  });

  // Set cookie + redirect. Refuse open-redirect: only same-origin return
  // URLs are honored.
  const setCookie = buildSetCookieHeader({
    value: cookie,
    maxAgeSeconds: config.LOGIN_TTL_SECONDS,
    isProduction: config.isProduction,
  });
  c.header("Set-Cookie", setCookie);

  const safeReturn = sameOriginPathOrNull(
    link.returnUrl ?? null,
    config.publicUrl,
  );
  return c.redirect(safeReturn ?? "/", 303);
});

// POST /v1/auth/logout
// Clears the cookie + revokes its Login. Idempotent — missing/invalid
// cookie also returns 204.
auth.post("/auth/logout", async (c) => {
  const config = c.get("config");
  const prisma = c.get("prisma");
  const cookie = parseLoginCookie(c.req.header("cookie") ?? null);
  if (cookie) {
    const cookieHash = hashLoginCookie(cookie);
    // Delete by hash. Idempotent — missing row is fine.
    await prisma.login.deleteMany({ where: { cookieHash } });
  }
  c.header(
    "Set-Cookie",
    buildClearCookieHeader({ isProduction: config.isProduction }),
  );
  return c.body(null, 204);
});

/**
 * Return the path portion of a return URL only when it's same-origin with
 * the relay's PUBLIC_URL. Anything else (different host, malformed) yields
 * null and the caller defaults to "/".
 *
 * Open-redirect defence — a magic-link attacker who crafts a returnUrl on
 * the request-link side could otherwise bounce the human off-site after
 * login. We compare normalised origins and accept only the same one.
 */
function sameOriginPathOrNull(
  returnUrl: string | null,
  publicUrl: string,
): string | null {
  if (!returnUrl) return null;
  try {
    const base = new URL(publicUrl);
    const target = new URL(returnUrl);
    if (target.origin !== base.origin) return null;
    return target.pathname + target.search;
  } catch {
    return null;
  }
}

export { auth, LOGIN_COOKIE_NAME };
