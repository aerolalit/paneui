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

The hosted relay (`https://relay.paneui.com`) is the default — `pane register`
works out of the box. The CLI needs:

- **An agent API key.** Either pre-provided by the operator (as
  `PANE_API_KEY`), or obtained yourself via `pane register` (see "Registering"
  below). Once registered, the key is saved to the config file and you don't
  need `PANE_API_KEY` at all.
- **A relay URL.** Only relevant for self-hosters — set `PANE_URL` (or pass
  `--url`) to point at a non-hosted relay.

Output is JSON on stdout. Errors are `{"error":{"code","message"}}` on stderr
with a non-zero exit.

## Discover the CLI with `--help`

**Before using a command, run its help.** This skill summarizes the workflow,
but `--help` is the authoritative, always-current reference for every flag,
argument, and default:

- `pane --help` — the command list and global options.
- `pane <command> --help` — every flag and option for that command, e.g.
  `pane create --help`, `pane watch --help`, `pane send --help`,
  `pane register --help`.

If a command errors or you are unsure of an option name, **run `--help`
instead of guessing** — the CLI is self-documenting and the help text reflects
the installed version, which this skill may not.

## Registering

If you weren't handed an API key, provision one yourself — **once** — with:

```sh
pane register --name "<short-descriptive-agent-name>"
```

Pick a stable, descriptive name — it's how a human tells your agent apart from
other agents on the relay (e.g. `claude-code-lalit-macbook`, `ci-pr-review-bot`,
`telegram-helper`). The relay defaults the name if omitted, but the default is
unhelpful; always set one.

Self-hosters add `--url "$PANE_URL"` (or set `PANE_URL`) to target a
non-hosted relay.

Whether `pane register` works depends on the relay's `REGISTRATION_MODE`:

- `closed` (the default) — the endpoint returns 404. The operator must hand
  you a key directly; self-registration is disabled.
- `secret` — pass the operator-shared registration secret with `--secret <s>`
  or the `PANE_REGISTER_SECRET` env var. A missing/wrong secret is a 401.
- `open` (the hosted relay's mode) — public; `pane register --name <name>`
  works with no secret.

On success this calls the relay's `POST /v1/register`, mints an agent + API
key, and saves the key and relay URL to the CLI config file
(`${XDG_CONFIG_HOME:-~/.config}/pane/config.json`, mode 0600). After that,
every other command picks the key up from that file automatically — no env
vars needed.

- The key is not printed by default. Pass `--print-key` if you need it echoed.
- Run it just once; re-running mints a fresh agent each time.
- The relay rate-limits `/v1/register` per IP; if you hit it, `pane register`
  fails with `rate_limited` — wait and retry.

## Artifacts and sessions — the model

An **artifact** is a reusable UI template: the HTML, an optional event schema,
and an optional input schema. A **session** is one _use_ of an artifact — one
context, one human, one event log, one TTL. Many sessions per artifact.

The reusable artifact is the unit you should think in. **Start every task with
`pane artifact list`** (or `pane artifact search <keywords>`) to see what
already exists — a previous run may have authored exactly the UI you need. The
intended flow is: author an artifact **once** with `pane artifact create`, then
instance it **many times** with `pane create --artifact-id <slug>` — no HTML
re-sent, no regeneration. Per-instance data (the "PR metadata" that makes the
same PR-review page show _this_ PR) rides in `--input-data`; the page reads it
as `window.pane.inputData`.

There are two ways to give `pane create` an artifact:

- **By reference** — `--artifact-id <id|slug>` — instance an existing reusable
  artifact. The reuse path, and the one you should reach for first.
- **Inline** — `--artifact <path|inline>` — a one-off UI, defined on the call.
  The relay creates an anonymous artifact behind it; you never manage it. Use
  the inline form only for a **genuine one-off** — a UI you are sure you will
  never want again. Anything reusable belongs in `pane artifact create`.

## Search before you generate — the load-bearing rule

**Before you generate any artifact HTML, search for one that already exists.**

```sh
pane artifact search <keywords>     # e.g. pane artifact search "pr review"
pane artifact list                  # all your artifacts, recent first
```

You are ephemeral; the relay is durable. A previous session of yours (or this
agent on another run) may have already authored exactly the artifact you are
about to build — a PR-review page, an approval form, a survey. Regenerating it
from scratch wastes tokens and causes drift: ten separately-generated copies of
"the same" page will not stay the same. The artifact on the relay is the one
source of truth.

So the workflow is:

1. `pane artifact search <keywords>` — does a suitable artifact already exist?
2. **If yes** — use it: `pane create --artifact-id <id|slug>` (optionally
   `--input-data` for this instance's data). Inspect it first with
   `pane artifact show <id|slug>` — the `description` and each version's
   `input_schema` tell you what it does and what data it needs. Done — no HTML
   written.
3. **If nothing fits** — only then author. If the UI is genuinely a one-off,
   use the inline `pane create --artifact ...` form. If it is something you (or
   the operator) will want again, register it: `pane artifact create` — so the
   next session can find and reuse it.

A reusable artifact is only reusable if you look for it. Skipping the search
makes the whole feature dead weight.

## The commands

### `pane create` — start a session

Reference an existing artifact (the reuse path — see "Search before you
generate" above):

```sh
pane create --artifact-id pr-review --input-data ./pr-42.json --ttl 600
```

Or inline a one-off artifact:

```sh
pane create --artifact ./form.html --event-schema ./schema.json --ttl 600
```

- `--artifact-id <v>` — reference an existing artifact by id or slug. Pair with
  `--version <n>` to pin a specific version (defaults to the latest).
- `--artifact <v>` — inline HTML UI: a file path, or inline HTML. (A remote-URL
  type, `html-ref`, exists in the schema but the relay does not serve it in
  this release — pass the HTML inline.)
- `--event-schema <v>` — the event vocabulary (see **The schema** below). A `.json`
  file or inline JSON. Used with `--artifact`; not needed with `--artifact-id`.
  **Optional** — omit it for a view-only artifact (see **View-only artifacts**
  below); the session then accepts no `page`/`agent` events.
- `--input-data <v>` — this instance's seed data, a JSON object (file or inline
  JSON). The relay validates it against the artifact version's `input_schema`;
  the page reads it as `window.pane.inputData`. Works with either form.
- Exactly one of `--artifact-id` / `--artifact` must be given.
- Optional: `--ttl <seconds>`, `--participants <n>`, `--metadata <path|json>`,
  `--callback <path|json>`.

Prints `{ session_id, urls, tokens, expires_at }`. **Deliver `urls.humans[0]`
to the human** over whatever channel you already have (Telegram, Slack, email).
Keep `session_id`. `tokens` are per-participant auth already baked into the
`urls` — you don't normally use them directly; the CLI authenticates with
`PANE_API_KEY`.

### `pane artifact` — manage reusable artifacts

`pane artifact <subcommand>` — one command, several subcommands:

```sh
# search / list — find an existing artifact before generating one
pane artifact search "pr review"
pane artifact list

# show — full artifact: head metadata + every version (HTML, schemas)
pane artifact show pr-review

# create — register a named, reusable artifact (its v1)
pane artifact create --name "PR Review" --slug pr-review \
  --description "PR review page: diff + approve/request-changes" \
  --tags pr,review,code \
  --artifact ./pr-review.html --event-schema ./pr-review-schema.json \
  --input-schema ./pr-review-input.json
#   -> prints { artifact_id, slug, version }

# version — append a new immutable version (existing versions never change)
pane artifact version pr-review --artifact ./pr-review-v2.html \
  --event-schema ./pr-review-schema.json

# update — change head metadata only (never the content)
pane artifact update pr-review --description "..." --tags pr,review
```

- `search`/`list` return a **lean** list — `id, slug, name, description, tags,
latest_version, last_used_at` — no HTML. Fetch the HTML with `show` once you
  have chosen one.
- The `slug` is the durable handle: record it (`pr-review`) and later
  `pane create --artifact-id pr-review` with no search at all.
- `--input-schema` is optional JSON Schema describing the `input_data` the
  artifact needs. It doubles as documentation — it tells a future you exactly
  what data to pass.
- Editing an artifact **appends a version**; it never mutates an existing one.
  Sessions pin the version they were created with, so old sessions are
  unaffected by a new version.

## The schema

The schema is the contract for _every_ event on the session. The relay
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
        "properties": {
          "name": { "type": "string" },
          "rating": { "type": "integer" }
        },
        "required": ["name", "rating"]
      },
      "emittedBy": ["page"]
    },
    "assistant.reply": {
      "payload": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "message": { "type": "string" }
        },
        "required": ["title", "message"]
      },
      "emittedBy": ["agent"]
    }
  }
}
```

## View-only artifacts (reports, dashboards, charts)

The event schema is **optional**. An artifact created with no `--event-schema` is
**view-only**: a report, dashboard, or chart the human only _reads_ — there is
nothing to submit back.

- Omit `--event-schema` on `pane create --artifact ...` or `pane artifact create` to
  make a view-only artifact. The CLI sends no event schema.
- A view-only session declares an **empty event vocabulary, strictly enforced**.
  Every `page`/`agent` emit is rejected `422 unknown_event_type` — `pane.emit`
  in the page and `pane send` from the agent both fail. There is no event type
  the session will accept.
- A view-only artifact can still carry an `--input-schema` and be seeded per
  session with `--input-data` — that is how one report template renders many
  different reports. The input contract is independent of the event schema.
- Use this for anything the human only consumes: a status dashboard, a metrics
  chart, a generated report. If you need an answer back, give the artifact an
  event schema instead.

## Writing the artifact

The artifact is the HTML page the human sees. **It does not run like a normal
web page** — the relay serves it inside a locked-down sandboxed iframe with no
network access. Ordinary `<form action>`, `fetch()`, or `XMLHttpRequest` will
**not** work and the human's answer will never reach you.

Instead, the relay injects a global `window.pane` bridge. The artifact talks to
the session _only_ through it:

- `pane.emit(type, data?, opts?)` → `Promise<{ id, deduped }>` — send an event.
  `type` must exist in the schema with `"page"` in `emittedBy`; `data` must
  satisfy its `payload`. This is how the human's answer reaches you.
- `pane.on(type, handler)` → `unsubscribe` — react to events (e.g. an
  `assistant.reply` you sent via `pane send`).
- `pane.state` — `.events` (the log so far), `.last(type?)`, `.subscribe(fn)`.
- `pane.inputData` — this session's per-instance seed data: the `input_data`
  passed to `POST /v1/sessions`, validated by the relay against the artifact
  version's `input_schema`. `null` when the session was created without
  `input_data`. Read it to render this instance — e.g. a PR-review artifact
  does `window.pane.inputData.prTitle`.

### What a handler receives — the event envelope

`pane.on(type, handler)` calls `handler(ev)` with **one argument: the event
envelope**, _not_ the bare payload. The envelope shape is:

```js
{
  (id, session_id, author, ts, type, data, causation_id, idempotency_key);
}
```

The payload — the object you passed to `pane.emit(...)` or to
`pane send --data` — is in **`ev.data`**. So an event sent with
`pane send --type assistant.reply --data '{"title":"...","message":"..."}'`
arrives at the handler as `ev`, and the content is `ev.data.title` /
`ev.data.message`.

Two things to know:

- **Handlers also fire for replayed history.** When the iframe connects, every
  prior event is replayed through your `pane.on` handlers — including events
  sent _before_ the artifact loaded. A handler registered in an inline
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
  #reply-msg {
    white-space: pre-wrap;
  }
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

### `pane delete <id>` — close a session

```sh
pane delete ses_xxxx
```

Closes the session and tears it down (`DELETE /v1/sessions/:id`). Idempotent —
re-deleting an already-closed session is a no-op. Use it to clean up a session
you are done with rather than waiting for its TTL to expire.

### `pane config` — inspect the resolved config

```sh
pane config
```

Prints the relay URL and API-key prefix the CLI is currently using, where each
came from (`flag` / `env` / `store`), and the config-file path. Makes **no
network call**. The full API key is never printed — only a masked prefix. Run
it when a command fails with `config_error` to see what is actually set.

### `pane logout` — clear the saved credentials

```sh
pane logout
```

Deletes the locally-saved relay URL + API key from the CLI config file. This is
**local only** — it does not revoke the key on the relay; the key still works
if used again. To actually revoke the key, use `pane keys revoke`.

### `pane keys` — inspect or revoke your API key

```sh
pane keys list                 # show your agent's key info (one key per agent)
pane keys revoke --yes         # REVOKE your own key — a self-destruct
```

A pane agent has exactly one API key. `keys list` shows its metadata
(`key_prefix`, created/last-used, etc.) — never the full key. `keys revoke`
**permanently revokes your own key**; it stops working immediately and you
would have to `pane register` again. It refuses to run without `--yes`.

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

> Tip: run `pane <command> --help` first if you're unsure of any flag below —
> the help text is authoritative.

```sh
# 1. create the session
OUT=$(pane create --artifact ./review.html --event-schema ./review-schema.json --ttl 900)
SID=$(echo "$OUT" | jq -r .session_id)
URL=$(echo "$OUT" | jq -r '.urls.humans[0]')

# 2. deliver $URL to the human over your own channel (Telegram/Slack/email)

# 3. wait for the human's submit — run as a monitored process
pane watch "$SID" --type review.submitted
#    -> prints the review.submitted event as a JSON line, exits 0

# 4. act on the event's `data`
```
