// Single source of truth for the brand mark.
//
// Previously three near-identical SVGs lived in three files — system-pages.ts
// (header logo), system-pages.ts (/favicon.svg body), bridge/routes.ts
// (favicon data URI). They were structurally the same, but having three
// copies meant any future logo change would drift across surfaces (the
// user shipped a complaint about "the logo looks different in different
// parts of the app"). This file is the one canonical SVG, plus the
// thin wrappers each surface needs.

// The brand mark: a rounded-square tile filled with the brand gradient
// (cool blue → lilac → mint, lifted from the prototype at
// /tmp/owner-shell-v2.html), centred bold "P" in deep ink. Inherits the
// SVG viewBox so the same source renders crisp at any size.
//
// The "P" is rendered via <text> with a system-font stack so the file
// stays tiny + readable; the fallback chain includes the same fonts the
// rest of the relay UI uses, so it matches on every browser the relay
// supports without bundling a webfont.
const BRAND_GRADIENT_STOPS = `
  <stop offset="0%" stop-color="#93c5fd"/>
  <stop offset="60%" stop-color="#c4b5fd"/>
  <stop offset="100%" stop-color="#5eead4"/>
`;

const BRAND_INK = "#0f172a";
const BRAND_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', system-ui, sans-serif";

/**
 * The canonical brand-mark SVG body. ViewBox is 0 0 100 100.
 *
 * Note on gradient id: kept stable as `pane-brand-grad` so multiple
 * inline copies on the same page (header + a card decoration, say)
 * still each resolve the gradient. Browsers tolerate duplicate ids
 * for the local <defs> case but it's brittle — keep this rendered
 * inline to one place per page when possible.
 */
function brandSvgBody(opts: { gradientId: string }): string {
  return `<defs>
    <linearGradient id="${opts.gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">${BRAND_GRADIENT_STOPS}</linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#${opts.gradientId})"/>
  <text x="50" y="72" text-anchor="middle" font-family="${BRAND_FONT_STACK}" font-size="62" font-weight="800" fill="${BRAND_INK}">P</text>`;
}

/**
 * Inline SVG element for the relay's HTML header (size set by the wrapper
 * `<a class="brand">`). Same shape as the favicon — guaranteed by both
 * being derived from `brandSvgBody`.
 */
export const BRAND_LOGO = `<svg width="24" height="24" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${brandSvgBody({ gradientId: "pane-brand-grad" })}</svg>`;

/**
 * Standalone SVG (with the xmlns attribute) for the /favicon.svg endpoint
 * and the PWA manifest. Identical shape to BRAND_LOGO.
 */
export const BRAND_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${brandSvgBody({ gradientId: "pane-brand-grad" })}</svg>`;

/**
 * The same SVG, URL-encoded for use in `<link rel="icon" href="data:..."`.
 * Inlining (vs. /favicon.ico) avoids an extra HTTP round-trip on every
 * page load and keeps the relay deployment a single binary with no
 * static-asset directory. Both the shell CSP and the error-page CSP
 * explicitly allow `data:` in img-src for this reason.
 */
export const BRAND_FAVICON_DATA_HREF = `data:image/svg+xml,${encodeURIComponent(BRAND_FAVICON_SVG)}`;
