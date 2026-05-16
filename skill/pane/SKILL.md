---
name: pane
description: >-
  Hand a human a rich interactive UI by URL and get a structured answer back,
  from any agent — cron job, chat bot, CI, headless server. Use when a question
  is too rich for a text reply (a form, a picker, a doc-review view, a
  dashboard) and you need the human's answer as structured data. Drives the
  `pane` CLI: create a session, deliver the URL, watch for the result.
---

# pane

`pane` is a CLI for the Pane relay: a round-trip UI channel between agents and
humans. You render an HTML UI, the relay hands the human a URL, the human's
interactions come back to you as structured events.

## When to use this

Use `pane` when the human's answer is genuinely too rich for text — a form to
fill, options to rank, a document to mark up, a dashboard to act on. For a plain
question, just ask in text; `pane` only wins on the rich slice.

## Setup

Two environment variables (or `--url` / `--api-key` flags on any command):

- `PANE_URL` — the relay base URL, e.g. `https://pane.example.com`
- `PANE_API_KEY` — your agent key

Output is JSON on stdout. Errors are `{"error":{"code","message"}}` on stderr
with a non-zero exit. Run `pane --help` or `pane <command> --help` anytime.

## The four commands

### `pane create` — start a session

```sh
pane create --artifact ./form.html --schema ./schema.json --ttl 600
```

- `--artifact <v>` — the HTML UI. A file path, or inline HTML. For a remote
  URL, add `--artifact-type html-ref`.
- `--schema <v>` — the per-session event vocabulary. A `.json` file or inline
  JSON. Each event type declares a `payload` shape and an `emittedBy` list
  (`"page"` = the human's UI, `"agent"` = you).
- Optional: `--ttl <seconds>`, `--participants <n>`, `--metadata <path|json>`,
  `--callback <path|json>`.

Prints `{ session_id, urls, tokens, expires_at }`. **Deliver `urls.humans[0]`
to the human** over whatever channel you already have (Telegram, Slack, email).
Keep `session_id`.

A minimal schema:

```json
{
  "events": {
    "form.submitted": { "payload": {}, "emittedBy": ["page"] },
    "agent.hint":      { "payload": {}, "emittedBy": ["agent"] }
  }
}
```

### `pane watch <id>` — wait for the answer

`pane watch` holds a WebSocket and prints **one compact JSON object per line**
to stdout, flushing after each. This is the key command — it's how you wait for
the human.

```sh
pane watch ses_xxxx --type form.submitted
```

- `--type <t>` — exit 0 after the first event of that type. Use this to wait
  for the human's terminal action.
- `--once` — exit 0 after the very first event.
- bare — stream until interrupted (`SIGINT`).

On session close it prints a final `{"type":"_closed"}` line and exits 0.

### `pane state <id>` — non-blocking snapshot

```sh
pane state ses_xxxx
pane state ses_xxxx --since 42
```

Prints `{ meta, events, next_cursor }` without holding a connection. Use it for
a one-off check, or poll it with `--since <next_cursor>` instead of `watch`.

### `pane send <id>` — emit your own event

```sh
pane send ses_xxxx --type agent.hint --data '{"text":"try the second option"}'
```

`--data` is a file path or inline JSON. The event type must exist in the schema
with `agent` in its `emittedBy`. Use this to update the UI live while the human
works.

## The watch → Monitor pattern

`pane watch` is built to be a **monitored subprocess**. It blocks until the
awaited event lands, prints it, and exits 0 — so a supervising harness can wake
you with the result.

- **Claude Code Monitor tool**: launch `pane watch <id> --type form.submitted`
  as a monitored process. When the human submits, the line is printed, the
  process exits 0, and you are re-invoked with the event payload. No polling.
- **Shell pipeline**: `pane watch <id> | while read -r line; do ...; done`.
- **`jq` filter**: `pane watch <id> | jq -c 'select(.type=="comment.added")'`.
- **Polling alternative**: loop `pane state <id> --since <cursor>` where a held
  connection is awkward.

## Typical round trip

```sh
# 1. create the session
OUT=$(pane create --artifact ./review.html --schema ./review-schema.json --ttl 900)
SID=$(echo "$OUT" | jq -r .session_id)
URL=$(echo "$OUT" | jq -r .urls.humans[0])

# 2. deliver $URL to the human over your own channel (Telegram/Slack/email)

# 3. wait for the human's submit — run as a monitored process
pane watch "$SID" --type review.submitted
#    -> prints the review.submitted event as a JSON line, exits 0

# 4. act on the event's `data`
```
