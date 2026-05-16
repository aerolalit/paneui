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
- `--schema <v>` — the per-session event vocabulary (see **The schema** below).
  A `.json` file or inline JSON.
- Optional: `--ttl <seconds>`, `--participants <n>`, `--metadata <path|json>`,
  `--callback <path|json>`.

Prints `{ session_id, urls, tokens, expires_at }`. **Deliver `urls.humans[0]`
to the human** over whatever channel you already have (Telegram, Slack, email).
Keep `session_id`. `tokens` are per-participant auth already baked into the
`urls` — you don't normally use them directly; the CLI authenticates with
`PANE_API_KEY`.

## The schema

The schema is the contract for *every* event on the session. The relay
**rejects any event that violates it** — a wrong `data` shape, or the wrong
author. Get this right or the round trip silently fails.

Each entry under `events` declares:

- `payload` — a **JSON Schema** for the event's `data`. `{}` means "any
  object". Be as strict as you can: the relay validates `pane.emit(...)` /
  `pane send` data against it and rejects mismatches.
- `emittedBy` — who may emit this type: `"page"` (the human's UI, via the
  `pane.emit` bridge) and/or `"agent"` (you, via `pane send`). Emitting a
  type your side isn't listed in fails with `author_not_allowed`.

```json
{
  "events": {
    "form.submitted": {
      "payload": {
        "type": "object",
        "properties": { "name": { "type": "string" },
                         "rating": { "type": "integer" } },
        "required": ["name", "rating"]
      },
      "emittedBy": ["page"]
    },
    "assistant.reply": {
      "payload": {
        "type": "object",
        "properties": { "title": { "type": "string" },
                         "message": { "type": "string" } },
        "required": ["title", "message"]
      },
      "emittedBy": ["agent"]
    }
  }
}
```

## Writing the artifact

The artifact is the HTML page the human sees. **It does not run like a normal
web page** — the relay serves it inside a locked-down sandboxed iframe with no
network access. Ordinary `<form action>`, `fetch()`, or `XMLHttpRequest` will
**not** work and the human's answer will never reach you.

Instead, the relay injects a global `window.pane` bridge. The artifact talks to
the session *only* through it:

- `pane.emit(type, data?, opts?)` → `Promise<{ id, deduped }>` — send an event.
  `type` must exist in the schema with `"page"` in `emittedBy`; `data` must
  satisfy its `payload`. This is how the human's answer reaches you.
- `pane.on(type, handler)` → `unsubscribe` — react to events (e.g. an
  `assistant.reply` you sent via `pane send`).
- `pane.state` — `.events` (the log so far), `.last(type?)`, `.subscribe(fn)`.

### What a handler receives — the event envelope

`pane.on(type, handler)` calls `handler(ev)` with **one argument: the event
envelope**, *not* the bare payload. The envelope shape is:

```js
{ id, session_id, author, ts, type, data, causation_id, idempotency_key }
```

The payload — the object you passed to `pane.emit(...)` or to
`pane send --data` — is in **`ev.data`**. So an event sent with
`pane send --type assistant.reply --data '{"title":"...","message":"..."}'`
arrives at the handler as `ev`, and the content is `ev.data.title` /
`ev.data.message`.

Two things to know:

- **Handlers also fire for replayed history.** When the iframe connects, every
  prior event is replayed through your `pane.on` handlers — including events
  sent *before* the artifact loaded. A handler registered in an inline
  `<script>` still receives an `assistant.reply` that was sent earlier, so you
  don't need to race the agent.
- `pane.state.last(type)` returns the most recent envelope of that type (or the
  most recent of any type if you omit `type`) — use it to render "whatever the
  latest reply is" without wiring a handler.

A minimal working artifact for the schema above:

```html
<!doctype html>
<meta charset="utf-8" />
<style>
  #reply-msg { white-space: pre-wrap; }
</style>
<form id="f">
  <input name="name" placeholder="Your name" required />
  <input name="rating" type="number" min="1" max="5" required />
  <button>Submit</button>
</form>
<p id="status"></p>

<!-- The agent's reply renders here -->
<section id="reply" hidden>
  <h2 id="reply-title"></h2>
  <p id="reply-msg"></p>
</section>

<script>
  // The agent pushes a rich reply with
  //   pane send --type assistant.reply --data '{"title":"…","message":"…"}'
  // `ev` is the envelope; the payload is `ev.data`.
  pane.on("assistant.reply", (ev) => {
    const { title, message } = ev.data;
    // .textContent — never .innerHTML — so agent text can't inject markup.
    document.getElementById("reply-title").textContent = title;
    // `white-space: pre-wrap` (above) keeps `\n` in `message` as line breaks.
    document.getElementById("reply-msg").textContent = message;
    document.getElementById("reply").hidden = false;
  });

  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    // Emit the terminal event — this is what `pane watch --type` waits for.
    await pane.emit("form.submitted", {
      name: e.target.name.value,
      rating: Number(e.target.rating.value),
    });
    document.getElementById("status").textContent = "Sent — thank you.";
  });
</script>
```

**DON'T render the raw envelope.** Never `JSON.stringify(ev)` (or `ev.data`)
onto the page, and never use the envelope as a fallback display when a handler
isn't sure what to do. If a handler doesn't recognize an event, ignore it — the
page should only ever show specific `ev.data` fields it understands, rendered
into real DOM. The whole point of Pane is a proper UI; a JSON dump is a bug.

Rules of thumb when authoring the artifact:

- The event type you `pane.emit` for the human's final action **must match**
  the `--type` you later `pane watch` for. Above: `form.submitted`.
- A handler's argument is the **envelope** — read the payload from `ev.data`,
  and render its individual fields with `.textContent` into real elements.
- `pane` is ready by the time inline `<script>` runs — no need to wait for an
  init event.
- No external assets that need the network (CDN scripts, remote fonts/images):
  the sandbox CSP blocks them. Inline everything, or use data URIs.
- Keep the artifact self-contained — it's one HTML document.

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
- `--timeout <seconds>` — exit if no event arrives within the window (fails
  with code `ws_timeout`). Use it so you don't wait forever for a human who
  never opens the URL.
- bare — stream until interrupted (`SIGINT`).

**Outcomes — branch on these:**

- An event of your `--type` lands → its JSON line is printed, exit 0. The
  human answered; act on the event's `data`.
- The session expires or closes first → a final `{"type":"_closed"}` line is
  printed, exit 0. The human did **not** answer (TTL elapsed). Do not treat a
  `_closed` line as the answer — handle it as "no response".
- `--timeout` elapses → `{"error":{"code":"ws_timeout"}}` on stderr, non-zero
  exit.
- The relay drops the connection abnormally → `ws_closed_abnormally` on
  stderr, non-zero exit (distinct from a clean `_closed`).

### `pane state <id>` — non-blocking snapshot

```sh
pane state ses_xxxx
pane state ses_xxxx --since <next_cursor>
```

Prints `{ meta, events, next_cursor }` without holding a connection. Use it for
a one-off check, or poll it with `--since <next_cursor>` instead of `watch`.

### `pane send <id>` — emit your own event

```sh
pane send ses_xxxx --type assistant.reply \
  --data '{"title":"Got it","message":"Thanks — your rating is recorded."}'
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
URL=$(echo "$OUT" | jq -r '.urls.humans[0]')

# 2. deliver $URL to the human over your own channel (Telegram/Slack/email)

# 3. wait for the human's submit — run as a monitored process
pane watch "$SID" --type review.submitted
#    -> prints the review.submitted event as a JSON line, exits 0

# 4. act on the event's `data`
```
