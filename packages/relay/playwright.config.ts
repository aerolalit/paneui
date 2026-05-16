import { defineConfig, devices } from "@playwright/test";

// Playwright config for the phase-3 browser-path smoke test. Kept separate from
// the vitest suite (`npm test`): vitest's default glob would also match a
// `*.spec.ts`/`*.test.ts` file, so the browser spec uses the `*.pwspec.ts`
// suffix and Playwright is pointed at it explicitly here. Run it with
// `npm run test:browser` (after `npx playwright install chromium`).
export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.pwspec.ts",
  // Regenerate the SQLite-targeted Prisma client before any test runs. The relay
  // has two Prisma schemas generating to the same client; the browser harness
  // needs the SQLite one. Makes the suite deterministic even via `npx playwright
  // test` (which bypasses the npm `pretest:browser` hook). See global-setup.ts.
  globalSetup: "./test/browser/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
