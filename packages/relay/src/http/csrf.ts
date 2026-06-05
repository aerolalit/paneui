// CSRF defence for cookie-authenticated mutations (F-07).
//
// The human-side surface authenticates with the `pane_login` cookie. The
// cookie is HttpOnly + SameSite=Lax + Secure(prod), which stops a *cross-site
// form POST* from carrying it — but SameSite=Lax is the only barrier, and it
// is a defence-in-depth layer the browser owns, not the relay. Lax also still
// attaches the cookie to top-level GET navigations, and the lax-allows-unsafe
// edge cases (and older browsers) leave a residual cross-site-POST risk. We
// add a server-side Origin/Referer check so the relay itself refuses a forged
// state-changing request rather than trusting SameSite alone.
//
// Scope: applied ONLY to the cookie-authed mounts (/v1/self, /v1/my-panes,
// /v1/my-trash, /v1/my-templates, /panes, and POST /v1/auth/logout). The agent
// API (/v1 bearer routes) is NOT cookie-authed — a stolen browser cookie can't
// drive it — so it is intentionally excluded; an agent caller need not (and
// often cannot) send a browser Origin header.
//
// Rule (for unsafe methods only — GET/HEAD/OPTIONS are exempt because they are
// not state-changing, and the magic-link verify GET must keep working):
//
//   - No `pane_login` cookie on the request  -> ALLOW. There is no session to
//     ride, so there is nothing to forge; the route's own requireHuman gate
//     will 401 it. This keeps unauthenticated / agent-style callers (which
//     send no Origin) working.
//   - Cookie present, Origin OR Referer present -> the supplied value MUST
//     match the relay's own origin (config.publicUrl). A mismatch is a 403.
//   - Cookie present, NEITHER Origin nor Referer present -> ALLOW. This is the
//     established CSRF pattern (Hono's own csrf() middleware, OWASP, Django's
//     referer check): a cross-site browser POST ALWAYS carries an Origin
//     (every fetch/XHR, and every cross-origin form submission in modern
//     browsers) or at minimum a Referer, so an absent-both request cannot be a
//     forged cross-site browser request. Blocking the absent case instead
//     would break legitimate non-browser callers (and same-origin server-side
//     navigations) without closing any real CSRF vector.
//
// The legitimate SPA is unaffected: the browser attaches Origin to its fetch()
// calls, and that Origin equals config.publicUrl.

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";
import { parseLoginCookie } from "../auth/cookie.js";
import { errors } from "./errors.js";

// Methods that never change state — exempt from the Origin check. GET in
// particular MUST stay exempt so the magic-link verify navigation (GET
// /v1/auth/verify) and the owner-shell HTML GETs keep working.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Normalise a URL string to its origin (scheme://host[:port]) or null. */
function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Reject cookie-authed unsafe (non-GET/HEAD/OPTIONS) requests whose Origin
 * (falling back to Referer) does not match the relay's own origin. Requests
 * without a `pane_login` cookie are allowed through untouched — the mounted
 * route's requireHuman gate handles the unauthenticated case.
 */
export const csrfProtect: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  // No session cookie => nothing to forge. Let the route's auth gate decide.
  const hasSession = parseLoginCookie(c.req.header("cookie") ?? null) !== null;
  if (!hasSession) {
    await next();
    return;
  }

  // Origin is the authoritative signal (sent by browsers on every
  // fetch/XHR/cross-origin form post); Referer is the fallback for the
  // top-level same-origin form-post case that some browsers leave Origin off.
  // A raw Origin of "null" (sandboxed iframe / opaque origin) is treated as a
  // present-but-mismatched value and rejected — it can never equal our origin.
  const rawOrigin = c.req.header("origin");
  const rawReferer = c.req.header("referer");

  // Neither header present: not a forgeable cross-site browser request — allow.
  if (
    (rawOrigin === undefined || rawOrigin === "") &&
    (rawReferer === undefined || rawReferer === "")
  ) {
    await next();
    return;
  }

  const selfOrigin = originOf(c.get("config").publicUrl);
  const reqOrigin =
    (rawOrigin !== undefined && rawOrigin !== ""
      ? originOf(rawOrigin)
      : null) ?? originOf(rawReferer);

  if (reqOrigin === null || reqOrigin !== selfOrigin) {
    throw errors.forbidden(
      "csrf_origin_mismatch",
      "cross-origin state-changing request rejected",
      "this cookie-authenticated request's Origin (or Referer) header does not match the relay's own origin; cross-site requests are refused to prevent CSRF",
    );
  }

  await next();
};
