#!/usr/bin/env node
// One-shot generator for src/app-icon.ts. Renders the canonical marketing mark
// (site/favicon.svg) to opaque full-bleed PNGs and embeds them as base64.
//
// Usage (from repo root):
//   for s in 180 192 512; do \
//     rsvg-convert -w $s -h $s -b '#0f172a' site/favicon.svg -o /tmp/icon-$s.png; \
//   done
//   node packages/relay/scripts/gen-app-icon.cjs /tmp/icon-180.png /tmp/icon-192.png /tmp/icon-512.png
const fs = require("fs");
const path = require("path");

const [p180, p192, p512] = process.argv.slice(2);
if (!p180 || !p192 || !p512) {
  console.error("expected three PNG paths: 180 192 512");
  process.exit(1);
}
const b64 = (p) => fs.readFileSync(p).toString("base64");

const body = `// App / home-screen install icon assets. GENERATED — see scripts/gen-app-icon.cjs.
//
// These PNGs render the brand robot mark (the navy tile + cyan circle + purple
// chat-bubble face). It is the SAME mark as the in-app favicon and header —
// both derive from the same artwork (site/favicon.svg == brand.ts's
// BRAND_MARK_SVG_BODY) — so the logo is consistent across every surface:
// browser tab, in-app header/sidebar, the viewer shell, and this install icon.
// Keep them in lockstep: if the mark changes, re-run this generator too.
//
// Why embedded base64 instead of files: the relay ships as a single binary with
// no static-asset directory (same rationale as BRAND_FAVICON_DATA_HREF in
// brand.ts). These are served as real same-origin routes (not data: URIs) so
// iOS Safari's Add-to-Home-Screen picks them up via <link rel="apple-touch-icon">
// and the manifest icons[] — iOS ignores SVG-only manifest icons, which is why
// the home-screen shortcut previously fell back to a screenshot.
//
// Regenerate with rsvg-convert against the canonical mark (from repo root):
//   for s in 180 192 512; do rsvg-convert -w $s -h $s -b '#0f172a' \\
//     site/favicon.svg -o /tmp/icon-$s.png; done
//   node packages/relay/scripts/gen-app-icon.cjs /tmp/icon-180.png /tmp/icon-192.png /tmp/icon-512.png
// The -b background fills the rounded corners with the tile navy so iOS masks
// cleanly (full-bleed opaque square, no transparent corners).

/** 180x180 PNG — the iOS apple-touch-icon size. */
export const APP_ICON_180_PNG = Buffer.from(
  "${b64(p180)}",
  "base64",
);

/** 192x192 PNG — PWA manifest icon (Android / desktop install). */
export const APP_ICON_192_PNG = Buffer.from(
  "${b64(p192)}",
  "base64",
);

/** 512x512 PNG — PWA manifest icon + maskable source. */
export const APP_ICON_512_PNG = Buffer.from(
  "${b64(p512)}",
  "base64",
);
`;

const outPath = path.join(__dirname, "..", "src", "app-icon.ts");
fs.writeFileSync(outPath, body);
console.log(`wrote ${outPath} (${body.length} bytes)`);
