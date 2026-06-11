// telegram-bot-approval — a Telegram bot that, on /approve, hands the human a
// pane URL for a rich decision and receives the structured result back over
// @paneui/core (no @paneui/cli needed — this talks to the relay directly).
//
// Flow:
//   1. Human DMs the bot `/approve`.
//   2. Bot creates a pane (inline HTML template + event schema), seeded with the
//      thing to decide on via input_data.
//   3. Bot DMs the human urls.humans[0].
//   4. Bot opens a WebSocket to the pane (openStream) and waits for the human's
//      `release.decided` event.
//   5. When it lands, the bot DMs the structured result back into the chat.
//
// Run:
//   npm install
//   PANE_API_KEY=pane_... TELEGRAM_BOT_TOKEN=123:abc npm start
//
// Self-hosters also set PANE_URL to point at their own relay.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import TelegramBot from "node-telegram-bot-api";
import {
  PaneClient,
  openStream,
  type CreatePaneResponse,
  type PaneEvent,
  type StreamHandlers,
} from "@paneui/core";

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const PANE_API_KEY = requireEnv("PANE_API_KEY");
const PANE_URL = process.env.PANE_URL ?? "https://relay.paneui.com";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_HTML = readFileSync(join(here, "release-approval.html"), "utf8");
const EVENT_SCHEMA = JSON.parse(
  readFileSync(join(here, "release-approval.schema.json"), "utf8"),
) as unknown;

const pane = new PaneClient({ url: PANE_URL, apiKey: PANE_API_KEY });
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// The decision payload the page emits (matches release-approval.schema.json).
interface ReleaseDecision {
  decision: "approve" | "reject";
  reason?: string;
}

bot.onText(/^\/approve\b/, async (msg) => {
  const chatId = msg.chat.id;

  // The thing we want a decision on. In a real bot this comes from your CI /
  // deploy system; here it's a static example.
  const release = {
    service: "checkout-api",
    version: "v2.4.0",
    changes: [
      "Switch payment provider to Stripe",
      "Add idempotency keys to refund endpoint",
      "Drop the deprecated /v1/charge route",
    ],
  };

  let created: CreatePaneResponse;
  try {
    created = await pane.createPane({
      template: {
        type: "html-inline",
        name: "Release approval",
        source: TEMPLATE_HTML,
        event_schema: EVENT_SCHEMA,
      },
      input_data: release,
      title: `Release ${release.service} ${release.version}?`,
      ttl: 1800, // 30 minutes for the human to decide
    });
  } catch (err) {
    await bot.sendMessage(
      chatId,
      `Couldn't create the approval pane: ${errMessage(err)}`,
    );
    return;
  }

  const humanUrl = created.urls.humans[0];
  await bot.sendMessage(
    chatId,
    `Review and decide on *${release.service} ${release.version}*:\n${humanUrl}`,
    { parse_mode: "Markdown" },
  );

  // Wait for the human's decision over the pane's WebSocket. openStream replays
  // history on connect, then streams live events; we resolve on the first
  // terminal `release.decided`.
  let settled = false;
  const handlers: StreamHandlers = {
    onEvent: (ev: PaneEvent) => {
      if (ev.type !== "release.decided" || settled) return;
      settled = true;
      const data = ev.data as ReleaseDecision;
      const verb = data.decision === "approve" ? "✅ Approved" : "⛔️ Rejected";
      const reason = data.reason ? `\nReason: ${data.reason}` : "";
      void bot.sendMessage(
        chatId,
        `${verb} ${release.service} ${release.version}.${reason}`,
      );
      handle.close();
    },
    onError: (e) => {
      if (settled) return;
      void bot.sendMessage(chatId, `Stream error: ${e.message}`);
    },
  };
  const handle = openStream(
    {
      wsBaseUrl: pane.wsBaseUrl,
      paneId: created.pane_id,
      token: created.tokens.agent,
    },
    handlers,
  );
});

bot.onText(/^\/start\b/, (msg) => {
  void bot.sendMessage(
    msg.chat.id,
    "Send /approve and I'll hand you a release-approval pane to decide on.",
  );
});

console.log(
  "Telegram approval bot is polling. DM it /approve to try the round trip.",
);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
