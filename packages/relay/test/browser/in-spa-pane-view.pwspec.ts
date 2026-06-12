// Browser test for the in-SPA pane view (owner /home).
//
// Guards the behaviour that unit/e2e tests can't see — it lives in the inline
// SPA <script>, which tsc doesn't typecheck and which only does its thing in a
// real browser with a real history stack. Each assertion here maps to a bug we
// actually shipped to a preview:
//
//   1. Clicking a pane opens it IN the SPA (pushState /panes/:id, host iframe
//      mounted, nav hidden) — not a full-page navigation.
//   2. ONE browser Back returns to the list — not a white iframe blank that
//      needs a second Back (the iframe-history-entry bug).
//   3. The list's scroll position is restored on Back (all views share one
//      .main scroll container, so this is not free).
//   4. No uncaught page errors — e.g. the chrome-free embedded shell must not
//      null-deref on its presence elements.
//
// Run: npm run test:browser  (after `npx playwright install chromium`).

import { test, expect } from "@playwright/test";
import {
  startRelay,
  createOwnerSession,
  type RelayHandle,
} from "./relay-harness.js";

let relay: RelayHandle;

test.beforeAll(async () => {
  relay = await startRelay();
});

test.afterAll(async () => {
  if (relay) await relay.stop();
});

test("in-SPA pane view: open in place, one Back, scroll restored, no crash", async ({
  page,
  context,
}) => {
  const owner = await createOwnerSession(relay.prisma, 25);
  await context.addCookies([
    { name: "pane_login", value: owner.cookie, url: relay.baseUrl },
  ]);

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(relay.baseUrl + "/home");

  // Land on the Panes tab and wait for the list to render.
  await page.click('#nav-items button[data-view="panes"]');
  await expect(page.locator('.view[data-view="panes"]')).toHaveClass(/active/);
  await expect(page.locator(".pane-row").first()).toBeAttached();

  // Scroll the shared .main container down, then read the clamped value back.
  const recorded = await page.locator(".main").evaluate((el) => {
    el.scrollTop = 600;
    return el.scrollTop;
  });
  expect(recorded).toBeGreaterThan(0); // the list really is scrollable

  // Open a pane WITHOUT Playwright auto-scrolling the row into view (that would
  // move .main). dispatchEvent fires a bubbling click the body handler catches.
  await page.locator(".pane-row").first().dispatchEvent("click");

  // (1) Opened in-SPA: URL pushed to /panes/:id, pane view active, host iframe
  // pointed at the embedded shell, and the SPA nav hidden (full-screen).
  await expect(page).toHaveURL(/\/panes\/[^/?#]+$/);
  await expect(page.locator('.view[data-view="pane"]')).toHaveClass(/active/);
  await expect(page.locator("#pane-host-frame")).toHaveAttribute(
    "src",
    /\/panes\/.+\?embedded=1$/,
  );
  await expect(page.locator(".app")).toHaveClass(/viewing-pane/);

  // (2) + (3) ONE Back returns to the list (not a blank iframe) with scroll
  // restored, and the host iframe is torn down to about:blank.
  await page.goBack();
  await expect(page.locator('.view[data-view="panes"]')).toHaveClass(/active/);
  await expect(page.locator('.view[data-view="pane"]')).not.toHaveClass(
    /active/,
  );
  await expect(page.locator("#pane-host-frame")).toHaveAttribute(
    "src",
    "about:blank",
  );
  const restored = await page.locator(".main").evaluate((el) => el.scrollTop);
  expect(restored).toBe(recorded);

  // (4) Nothing crashed (incl. the chrome-free embedded shell's presence stub).
  expect(pageErrors).toEqual([]);
});
