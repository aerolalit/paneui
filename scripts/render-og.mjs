// scripts/render-og.mjs
//
// Render site/og.html → site/og.png at the exact 1200×630 OG / Twitter-card
// spec, using playwright + chromium. The HTML file is the design source; this
// script just snapshots it, so any update to og.html flows through.
//
// Usage:
//   npm run site:og
//
// Why playwright over puppeteer: playwright is already a workspace dep
// (packages/relay uses it for browser tests), so we don't add another binary.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SRC = path.join(repoRoot, "site", "og.html");
const OUT = path.join(repoRoot, "site", "og.png");

// OG / Twitter card spec — Slack, Discord, X, LinkedIn, iMessage all assume
// these dimensions; deviating crops the preview unpredictably.
const WIDTH = 1200;
const HEIGHT = 630;
// 2× device pixel ratio so the PNG is crisp on retina previews.
const DPR = 2;

if (!existsSync(SRC)) {
  console.error(`error: ${SRC} does not exist`);
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: DPR,
  });
  const page = await ctx.newPage();
  await page.goto(`file://${SRC}`, { waitUntil: "networkidle" });
  // wait a tick so any layout settles (no fonts loaded over the wire here,
  // but this guards against transient layout shifts).
  await page.waitForTimeout(50);
  await page.screenshot({
    path: OUT,
    type: "png",
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
  });
  console.log(`wrote ${path.relative(repoRoot, OUT)}  (${WIDTH}×${HEIGHT} @${DPR}x)`);
} finally {
  await browser.close();
}
