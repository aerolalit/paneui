# telegram-bot-approval

A minimal Telegram bot that, on `/approve`, hands the human a **pane URL** for a
rich release-approval decision and receives the structured result back over
[`@paneui/core`](https://www.npmjs.com/package/@paneui/core). The agent (the bot)
lives entirely outside any GUI host — it only makes outbound calls to the relay
and delivers the URL as a Telegram DM. That's the out-of-band case pane is built
for: the human decides on whatever device opened the link, and the answer comes
back to the bot as data.

No `@paneui/cli` here — this talks to the relay directly through `PaneClient`
(create the pane) and `openStream` (wait for the decision over a WebSocket).

## What's here

| File | Purpose |
|---|---|
| `src/bot.ts` | The bot. Handles `/approve`, creates a pane, DMs the URL, opens a stream, and replies with the decision. |
| `src/release-approval.html` | The pane UI — a release summary, Approve/Reject buttons, an optional reason. |
| `src/release-approval.schema.json` | The event schema — one page event, `release.decided`. |
| `package.json` | Standalone (not part of the pane workspace). Deps: `@paneui/core`, `node-telegram-bot-api`. |

## Run it

```sh
cd examples/telegram-bot-approval
npm install

# A Telegram bot token from @BotFather, and a pane agent API key.
export TELEGRAM_BOT_TOKEN="123456:ABC-your-bot-token"
export PANE_API_KEY="pane_your_agent_key"   # from `pane agent register --print-key`
# export PANE_URL="https://relay.example.com"   # self-hosters only

npm start
```

Then DM your bot `/approve` in Telegram. It replies with a pane URL; open it,
make a decision, and the bot DMs the result back into the chat.

> `npm start` runs `node --experimental-strip-types src/bot.ts` (Node 20.6+ /
> 22+ runs the TypeScript directly). On older Node, compile with `tsc` or use
> `tsx`.

## How the round trip works in code

**1. Create the pane** with `PaneClient` — inline the HTML template + event
schema, seed the release details with `input_data`:

```ts
const pane = new PaneClient({ url: PANE_URL, apiKey: PANE_API_KEY });

const created = await pane.createPane({
  template: { type: "html-inline", name: "Release approval", source: TEMPLATE_HTML, event_schema: EVENT_SCHEMA },
  input_data: release,            // page reads this as window.pane.inputData
  title: `Release ${release.service} ${release.version}?`,
  ttl: 1800,
});
```

**2. Deliver `created.urls.humans[0]`** over Telegram:

```ts
await bot.sendMessage(chatId, `Review and decide:\n${created.urls.humans[0]}`);
```

**3. Wait for the decision** with `openStream` — it replays history on connect,
then streams live events. Resolve on the first `release.decided`:

```ts
const handle = openStream(
  { wsBaseUrl: pane.wsBaseUrl, paneId: created.pane_id, token: created.tokens.agent },
  {
    onEvent: (ev) => {
      if (ev.type !== "release.decided") return;
      const { decision, reason } = ev.data as { decision: string; reason?: string };
      bot.sendMessage(chatId, `${decision} — ${reason ?? "(no reason)"}`);
      handle.close();
    },
  },
);
```

The bot never holds a public address; the relay brokers the whole exchange.

## Notes

- The example resolves `@paneui/core` from npm at version `^0.0.18` — keep it in
  lockstep with the relay you target (`pane skill version --plain` reports the
  relay's version).
- For a long-lived production bot you'd persist `pane_id` → `chatId` and survive
  restarts by reconnecting `openStream` with `since` (the last seen event id),
  or by polling `GET /v1/panes/:id/events?since=…&wait=…` instead — see the
  `ci-deploy-gate` example for the polling variant.
