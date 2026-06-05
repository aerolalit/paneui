// Single source of truth for the brand mark.
//
// The mark is the "Pane" robot: a navy rounded-square tile with a cyan circle
// and a purple chat-bubble face (two eyes). It is identical to the marketing
// site mark (site/favicon.svg) and the home-screen / PWA install icons
// (src/app-icon.ts), so the logo is the SAME on every surface — browser tab
// favicon, in-app header + sidebar, the pane viewer shell, and the installed
// app icon.
//
// History: the in-app favicon/header once used a gradient-"P" while the viewer
// shell, marketing site, and install icons used the robot. That cross-surface
// split was unified onto the robot (the user asked for one consistent icon).
// Keep ALL mark rendering derived from BRAND_MARK_SVG_BODY below so the
// surfaces can't drift apart again.

/**
 * The brand-mark artwork as inner SVG elements, on a `0 0 100 100` viewBox.
 * Self-contained — it carries its own navy tile background — so it renders as
 * a complete icon at any size with no extra wrapper styling. Byte-for-byte the
 * same geometry as site/favicon.svg, the source the app-icon.ts PNGs are
 * rasterised from, so the vector favicon and the raster install icons match.
 */
export const BRAND_MARK_SVG_BODY = `<rect width="100" height="100" rx="22" fill="#0f172a"/>
  <circle cx="62" cy="58" r="17.5" fill="#22d3ee"/>
  <rect x="20" y="26" width="40" height="32" rx="10" fill="#0f172a"/>
  <rect x="24" y="30" width="32" height="24" rx="7" fill="#a78bfa"/>
  <circle cx="33.5" cy="42" r="3.4" fill="#0f172a"/>
  <circle cx="46.5" cy="42" r="3.4" fill="#0f172a"/>`;

/**
 * Inline SVG element for the relay's HTML header + sidebar (display size set by
 * the wrapper). Same artwork as the favicon — both derive from
 * BRAND_MARK_SVG_BODY.
 */
export const BRAND_LOGO = `<svg width="24" height="24" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${BRAND_MARK_SVG_BODY}</svg>`;

/**
 * Standalone SVG (with the xmlns attribute) for the /favicon.svg endpoint and
 * the PWA manifest's SVG fallback. Identical artwork to BRAND_LOGO.
 */
export const BRAND_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${BRAND_MARK_SVG_BODY}</svg>`;

/**
 * The same SVG, URL-encoded for use in `<link rel="icon" href="data:...">`.
 * Inlining (vs. /favicon.ico) avoids an extra HTTP round-trip on every page
 * load and keeps the relay deployment a single binary with no static-asset
 * directory. Both the shell CSP and the error-page CSP explicitly allow
 * `data:` in img-src for this reason.
 */
export const BRAND_FAVICON_DATA_HREF = `data:image/svg+xml,${encodeURIComponent(BRAND_FAVICON_SVG)}`;
