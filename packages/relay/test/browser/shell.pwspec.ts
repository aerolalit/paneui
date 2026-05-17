// Phase-3 browser-path smoke test.
//
// This is the automated check that replaces the screenshot-by-screenshot
// manual loop. It boots a real relay, opens the human `/s/:token` shell page
// in a real Chromium, and asserts the four things that have each been a real
// shipped bug in this path:
//
//   1. The shell page loads with NO uncaught console / page errors.
//      (Would have caught the inlined `export` SyntaxError and the
//      `postMessage` invalid-targetOrigin throw.)
//   2. The shell WebSocket reaches OPEN and STAYS open — no connect/close
//      churn. Asserted both from the browser side (one websocket, never
//      closed) and the relay side (exactly one participant.joined for the
//      human, zero participant.left). (Catches the current reconnect loop.)
//   3. The artifact renders inside the sandboxed iframe as real DOM, not raw
//      text. (Catches the `</script>` early-tag-close bug.)
//   4. A `pane.emit` from inside the artifact round-trips: the relay records
//      the event and the artifact receives the ack.
//
// Run: npm run test:browser  (after `npx playwright install chromium`).

import { test, expect } from "@playwright/test";
import {
  startRelay,
  createSession,
  type RelayHandle,
} from "./relay-harness.js";

let relay: RelayHandle;

test.beforeAll(async () => {
  relay = await startRelay();
});

test.afterAll(async () => {
  if (relay) await relay.stop();
});

test("phase-3 shell: loads, holds one stable WS, renders artifact, round-trips emit", async ({
  page,
}) => {
  const session = await createSession(relay.baseUrl);

  // --- collect every console error and uncaught page error -----------------
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push("pageerror: " + err.message);
  });

  // --- track every WebSocket the page opens and whether it closed ----------
  let wsOpened = 0;
  let wsClosed = 0;
  page.on("websocket", (ws) => {
    wsOpened++;
    ws.on("close", () => {
      wsClosed++;
    });
  });

  await page.goto(session.humanUrl);

  // (2a) The status pill flips to "connected" once the WS is OPEN.
  await expect(page.locator("#status")).toHaveText("connected", {
    timeout: 10_000,
  });

  // (3) The artifact rendered as real DOM inside the sandboxed iframe — if the
  // `</script>` bug were present the marker would leak as page text instead.
  const frame = page.frameLocator("#frame");
  await expect(frame.locator("#artifact-marker")).toHaveText(
    "PANE ARTIFACT RENDERED",
    { timeout: 10_000 },
  );

  // (2b) Hold for several seconds, then assert the WS did NOT churn. Exactly
  // one socket, still open. This is the assertion that fails on the reconnect
  // loop bug.
  await page.waitForTimeout(6_000);
  expect(wsOpened, "browser should open exactly one WebSocket").toBe(1);
  expect(wsClosed, "the WebSocket must not close/churn").toBe(0);
  await expect(page.locator("#status")).toHaveText("connected");

  // (1) No uncaught errors during load + idle.
  expect(consoleErrors, "no uncaught console/page errors").toEqual([]);

  // (2c) Relay-side proof of no churn: one human join, no human leave.
  const humanJoins = await relay.prisma.event.count({
    where: { sessionId: session.sessionId, type: "system.participant.joined" },
  });
  const humanLefts = await relay.prisma.event.count({
    where: { sessionId: session.sessionId, type: "system.participant.left" },
  });
  expect(humanJoins, "exactly one participant.joined").toBe(1);
  expect(humanLefts, "no participant.left churn").toBe(0);

  // (4) Emit round-trip: click the artifact button -> pane.emit -> relay
  // records a `ping` event -> artifact receives the ack and renders the id.
  await frame.locator("#emit-btn").click();
  await expect(frame.locator("#emit-result")).toContainText("EMIT_OK:", {
    timeout: 10_000,
  });
  const pings = await relay.prisma.event.count({
    where: { sessionId: session.sessionId, type: "ping" },
  });
  expect(pings, "relay recorded the emitted event").toBe(1);

  // Final guard: still exactly one stable socket after the emit round-trip.
  expect(wsOpened).toBe(1);
  expect(wsClosed).toBe(0);

  // (5) The /presence endpoint the shell polls returns JSON with the three
  // agent-presence facts. The token is the last path segment of the shell URL.
  const token = new URL(session.humanUrl).pathname
    .split("/")
    .filter(Boolean)
    .pop()!;
  const presenceRes = await page.request.get(
    `${relay.baseUrl}/s/${token}/presence`,
  );
  expect(presenceRes.status()).toBe(200);
  expect(presenceRes.headers()["content-type"]).toContain("application/json");
  const presence = (await presenceRes.json()) as {
    agentLive: boolean;
    agentLastEventAt: string | null;
    agentLastUsedAt: unknown;
  };
  expect(typeof presence.agentLive).toBe("boolean");
  expect("agentLastEventAt" in presence).toBe(true);
  expect("agentLastUsedAt" in presence).toBe(true);
});
