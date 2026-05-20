// scripts/render-favicons.mjs
//
// Renders the brand mark (site/favicon.svg) into the raster favicons modern
// browsers expect:
//
//   site/favicon-16.png       — 16×16, classic tab icon
//   site/favicon-32.png       — 32×32, retina/high-res tab icon
//   site/apple-touch-icon.png — 180×180, iOS home-screen + Safari pinned
//   site/favicon.ico          — 32×32 PNG renamed (browsers accept PNG inside
//                                the .ico slot when <link> declares type/sizes;
//                                we keep this for the bare /favicon.ico request
//                                that some clients still make blindly).
//
// Approach: playwright opens a tiny HTML wrapper that places the SVG at the
// exact target pixel size, then screenshots that bounding box. No build step,
// no Sharp / ImageMagick dependency — uses the same playwright we already
// pull in for site/og.png.
//
// Usage:
//   npm run site:favicons

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SVG_PATH = path.join(repoRoot, "site", "favicon.svg");

if (!existsSync(SVG_PATH)) {
  console.error(`error: ${SVG_PATH} does not exist`);
  process.exit(1);
}

const svgMarkup = readFileSync(SVG_PATH, "utf8");

// Each render: a wrapper HTML page sized exactly N×N with a single inline SVG
// stretched to fill it. We screenshot the viewport (no clipping math needed).
function wrap(size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${size}px;height:${size}px}
  </style></head><body>${svgMarkup}</body></html>`;
}

const targets = [
  { name: "favicon-16.png", size: 16 },
  { name: "favicon-32.png", size: 32 },
  { name: "apple-touch-icon.png", size: 180 },
];

const browser = await chromium.launch();
try {
  for (const t of targets) {
    const ctx = await browser.newContext({
      viewport: { width: t.size, height: t.size },
      // 2× internal so the rasterisation has subpixel headroom; we resize to
      // the target N by clipping the screenshot to N×N below.
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.setContent(wrap(t.size), { waitUntil: "load" });
    const out = path.join(repoRoot, "site", t.name);
    await page.screenshot({
      path: out,
      type: "png",
      omitBackground: true,
      clip: { x: 0, y: 0, width: t.size, height: t.size },
    });
    console.log(`wrote site/${t.name}  (${t.size}×${t.size})`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

// favicon.ico — a PNG renamed. Modern browsers accept PNG inside the .ico
// slot; the bare /favicon.ico request that some clients make blindly will get
// a 32×32 PNG, which decodes everywhere we care about.
const ico = path.join(repoRoot, "site", "favicon.ico");
copyFileSync(path.join(repoRoot, "site", "favicon-32.png"), ico);
console.log(`wrote site/favicon.ico  (copy of favicon-32.png)`);
