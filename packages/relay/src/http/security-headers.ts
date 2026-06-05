// Baseline security headers for the JSON API (F-10).
//
// The HTML + download routes (owner-shell, bridge, previews, icons,
// attachment download) each set a carefully-tuned Content-Security-Policy,
// X-Frame-Options, and Referrer-Policy. The JSON API (/v1/*, /s/*) set none,
// so a JSON response carried no transport-security or anti-sniff baseline.
//
// This middleware sets ONLY two headers, and ONLY ones that are safe to apply
// blanket across every response:
//
//   - X-Content-Type-Options: nosniff  — applied everywhere. The HTML/download
//     routes already set this same value, so re-setting it is a no-op there.
//   - Strict-Transport-Security        — production only (config.isProduction).
//     Pointless (and harmful for localhost http: dev) off production, and the
//     relay only terminates TLS behind a proxy in real deployments.
//
// CRITICAL: it deliberately does NOT set Content-Security-Policy,
// X-Frame-Options, or Referrer-Policy. Those are per-route concerns — the
// HTML/download routes tune them tightly (e.g. `frame-ancestors 'none'` +
// `X-Frame-Options: DENY` + `Referrer-Policy: no-referrer`) and a blanket
// value here would clobber them. Hono's built-in secureHeaders() sets headers
// AFTER next() runs (overwriting whatever the route set), which is exactly the
// clobbering we must avoid — so we hand-roll this and set the two headers
// BEFORE next(), letting any route still override them if it ever needs to.

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";

// One year, the conventional HSTS max-age. No `includeSubDomains` /
// `preload` — the relay may be hosted on a subdomain of a domain whose other
// subdomains the operator doesn't control, so we keep the directive scoped to
// the exact host and let operators opt into the stronger forms at their edge.
const HSTS_VALUE = "max-age=31536000";

/**
 * Set the baseline security headers (X-Content-Type-Options always;
 * Strict-Transport-Security in production only). Mounted globally in
 * buildApp() ahead of the routes; the per-route CSP/XFO/Referrer-Policy
 * headers the HTML + download routes set are intentionally left untouched.
 */
export const baselineSecurityHeaders: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  c.header("X-Content-Type-Options", "nosniff");
  if (c.get("config").isProduction) {
    c.header("Strict-Transport-Security", HSTS_VALUE);
  }
  await next();
};
