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
  buildClearMagicLinkNonceCookieHeader,
  buildMagicLinkNonceCookieHeader,
  buildSetCookieHeader,
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
  parseLoginCookie,
  parseMagicLinkNonceCookie,
} from "../../auth/cookie.js";
import {
  buildMagicLinkUrl,
  generateMagicLinkNonce,
  generateMagicLinkToken,
  hashMagicLinkNonce,
  hashMagicLinkToken,
  normalizeEmail,
} from "../../auth/magic-link.js";
import type { AppEnv } from "../env.js";
import { errors } from "../errors.js";
import { checkMagicLinkRateLimit } from "../rate-limit.js";
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
  // Optional display name. Carried via MagicLink.name to the verify
  // step; transferred to Human.name only when the verify creates a
  // fresh row. Trimmed; empty strings normalised to null.
  name: z
    .preprocess((v) => {
      if (typeof v !== "string") return v;
      const t = v.trim();
      return t.length === 0 ? undefined : t;
    }, z.string().min(1).max(80).optional())
    .optional(),
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
  const expiresAt = new Date(Date.now() + config.MAGIC_LINK_TTL_SECONDS * 1000);

  // F-09 — per-(IP, email) throttle. When the limit is hit we MUST still
  // return the same 202 the endpoint always returns: a different status here
  // would turn the rate limit into an account-enumeration oracle (an attacker
  // could distinguish "this address gets throttled" from "this one doesn't").
  // So on throttle we skip the MagicLink row + the email send entirely and
  // fall straight through to the identical 202 response below.
  if (!(await checkMagicLinkRateLimit(c, email))) {
    log.warn("magic-link request throttled", { email });
    return c.json({ ok: true, expires_at: expiresAt.toISOString() }, 202);
  }

  const token = generateMagicLinkToken();
  const tokenHash = hashMagicLinkToken(token);

  // F-16 — bind this link to the requester's browser. We mint a random nonce,
  // store only its hash on the row, and set the raw nonce as a short-lived
  // cookie (below). At verify time the cookie's hash must match this stored
  // hash, so a link minted for an attacker-controlled account can't log a
  // victim's browser into that account (login-CSRF / session fixation): the
  // victim's browser never holds the matching nonce cookie.
  const nonce = generateMagicLinkNonce();
  const nonceHash = hashMagicLinkNonce(nonce);

  // Insert the row BEFORE sending — if the provider fails we'd rather have
  // an unconsumed row that expires harmlessly than an email referencing a
  // token that doesn't exist.
  await prisma.magicLink.create({
    data: {
      email,
      tokenHash,
      nonceHash,
      expiresAt,
      returnUrl: body.returnUrl,
      name: body.name ?? null,
    },
  });

  // Set the nonce cookie now, on the request-link response, so the browser
  // that asked for the link carries it back on the verify navigation. Set it
  // before the (fallible) send so a provider 502 still leaves a usable cookie
  // for any link that did go out. SameSite=Lax so it survives the top-level
  // GET navigation from the email; Path=/v1/auth, HttpOnly, Secure in prod,
  // Max-Age = the magic-link TTL. (No-op for non-cookie clients; see the
  // null-nonceHash fallback in verify for backward compatibility.)
  c.header(
    "Set-Cookie",
    buildMagicLinkNonceCookieHeader({
      value: nonce,
      maxAgeSeconds: config.MAGIC_LINK_TTL_SECONDS,
      isProduction: config.isProduction,
    }),
  );

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
  const verifyAt = new Date();
  if (!link || link.consumedAt || link.expiresAt < verifyAt) {
    // Diagnostic only — the CLIENT response below is byte-identical across all
    // rejection branches (no account-enumeration / browser-binding oracle).
    // The server log distinguishes them so a "every link fails" report can be
    // pinned to a specific cause: `expired` with a small positive `skewMs`
    // points at relay clock skew; `already_consumed` at a link prefetcher;
    // `not_found` at a wrong/truncated token. (#magic-link-mobile)
    log.info("magic-link verify rejected", {
      reason: !link
        ? "not_found"
        : link.consumedAt
          ? "already_consumed"
          : "expired",
      ...(link
        ? {
            email: link.email,
            expiresAt: link.expiresAt.toISOString(),
            now: verifyAt.toISOString(),
            // >0 means the link was already past expiry at click time. A value
            // close to the TTL on a just-clicked link is the clock-skew tell.
            skewMs: verifyAt.getTime() - link.expiresAt.getTime(),
          }
        : {}),
    });
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

  // F-16 — nonce binding. The link is valid only from the browser that
  // requested it: hash the pane_ml_nonce cookie and require it to equal the
  // hash stored at request-link time. We check BEFORE the atomic consume so a
  // wrong-browser click doesn't burn the token (the legitimate requester can
  // still click later). On mismatch/absence we return the SAME invalid_token
  // 400 as an unknown/expired token — no oracle distinguishing "valid link,
  // wrong browser" from "no such link".
  //
  // Back-compat: rows with nonceHash = null predate this change (or were
  // minted by a non-cookie client). We can't enforce a nonce we never issued,
  // so a null nonceHash falls back to the prior behavior (no nonce check).
  // Every link minted after this change carries a nonceHash, so the binding
  // is enforced for all new links and the fallback is closed over time.
  if (link.nonceHash !== null) {
    const nonceCookie = parseMagicLinkNonceCookie(
      c.req.header("cookie") ?? null,
    );
    const presented = nonceCookie ? hashMagicLinkNonce(nonceCookie) : null;
    if (presented === null || presented !== link.nonceHash) {
      // Diagnostic only (see the rejection-log note above). `nonce_missing` is
      // the signature of a cross-browser-context click: the link was requested
      // in one cookie jar (e.g. an in-app webview / OAuth connector view) and
      // opened in another (the system browser), so the pane_ml_nonce cookie
      // never reaches verify. `nonce_mismatch` means a cookie WAS sent but
      // doesn't match — a genuinely different requester. (#magic-link-mobile)
      log.info("magic-link verify rejected", {
        reason: presented === null ? "nonce_missing" : "nonce_mismatch",
        email: link.email,
      });
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
  }

  // Atomic consume: claim the row by sweeping consumedAt = NULL. Returns 0
  // updated if a race won; we treat that as a 400 with the same message.
  const consumed = await prisma.magicLink.updateMany({
    where: { id: link.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    // Diagnostic only (see the rejection-log note above). The token passed
    // lookup + nonce but lost the consume race — a concurrent verify (often a
    // mail-client link prefetch firing alongside the human click) claimed the
    // row first. (#magic-link-mobile)
    log.info("magic-link verify rejected", {
      reason: "consume_race",
      email: link.email,
    });
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

  // Success — emit a matching positive signal so a fixed flow (e.g. Salina
  // completing the whole login in one system browser) shows up in the logs
  // next to the rejections it replaced. (#magic-link-mobile)
  log.info("magic-link verify ok", { email: link.email });

  // Find-or-create the Human row by email. Per the proposal §4.2:
  // verifiedAt is set on FIRST successful login only — it's the moment of
  // address ownership proof, not a timestamp of every subsequent click.
  // Email-invite signups (Phase E) create a Human with verifiedAt = null;
  // the first login is what flips it.
  const now = new Date();
  const existing = await prisma.human.findUnique({
    where: { email: link.email },
  });
  // First-verify special case: persist link.name if the row is freshly
  // created OR if an unverified row is being verified for the first time
  // AND has no name yet. We deliberately DO NOT overwrite an existing
  // name on returning logins — only the signup form captures the name,
  // and the column is purely display.
  const human = existing
    ? existing.verifiedAt
      ? existing
      : await prisma.human.update({
          where: { id: existing.id },
          data: {
            verifiedAt: now,
            ...(existing.name === null && link.name !== null
              ? { name: link.name }
              : {}),
          },
        })
    : await prisma.human.create({
        data: {
          email: link.email,
          verifiedAt: now,
          name: link.name ?? null,
        },
      });

  // Bind any pending identity-share grants addressed to this human's email.
  // An owner who invited `bob@…` created PaneGrant rows with humanId NULL +
  // inviteEmail = bob's email; bob's first successful login is the moment we
  // can safely attach them to his (now-proven) identity. Idempotent + best-
  // effort: a failure here must not block the login (the grant can be re-bound
  // on bob's next visit, or via a future reconcile). Done in a single
  // updateMany so concurrent logins can't double-bind.
  try {
    await prisma.paneGrant.updateMany({
      where: { inviteEmail: link.email, humanId: null },
      data: { humanId: human.id, acceptedAt: now },
    });
  } catch (err) {
    log.warn("pending grant binding failed", {
      humanId: human.id,
      error: String(err),
    });
  }

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

  // F-16 — the nonce has done its job; clear it so it can't be replayed and
  // doesn't linger past this login. Appended as a second Set-Cookie alongside
  // the login cookie (matching path so the browser actually drops it).
  c.header(
    "Set-Cookie",
    buildClearMagicLinkNonceCookieHeader({ isProduction: config.isProduction }),
    { append: true },
  );

  const safeReturn = sameOriginPathOrNull(
    link.returnUrl ?? null,
    config.publicUrl,
  );
  // Default landing on successful login is /home (Phase D system pages);
  // same-origin returnUrl is honored when present.
  return c.redirect(safeReturn ?? "/home", 303);
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
