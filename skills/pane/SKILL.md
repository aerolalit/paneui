---
name: pane
description: >-
  Hand a human a rich interactive UI by URL and get a structured answer back,
  from any agent — cron job, chat bot, CI, headless server. Use when a question
  is too rich for a text reply (a form, a picker, a doc-review view, a
  dashboard) and you need the human's answer as structured data. Drives the
  `pane` CLI: create a session, deliver the URL, watch for the result.
---

<!-- pane skill v2.2.0 -->

# pane

`pane` is a CLI for the Pane relay: a round-trip UI channel between agents and
humans. You render an HTML UI, the relay hands the human a URL, the human's
interactions come back to you as structured events.

## When to use this

Use `pane` when the human's answer is genuinely too rich for text — a form to
fill, options to rank, a document to mark up, a dashboard to act on. For a plain
question, just ask in text; `pane` only wins on the rich slice.

## Setup

The hosted relay (`https://relay.paneui.com`) is the default — `pane agent register`
works out of the box. The CLI needs:

- **An agent API key.** Either pre-provided by the operator (as
  `PANE_API_KEY`), or obtained yourself via `pane agent register` (see "Registering"
  below). Once registered, the key is saved to the config file and you don't
  need `PANE_API_KEY` at all.
- **A relay URL.** Only relevant for self-hosters — set `PANE_URL` (or pass
  `--url`) to point at a non-hosted relay.

Output is JSON on stdout. Errors are `{"error":{"code","message"}}` on stderr
with a non-zero exit.

## Keeping this skill up to date

This skill carries its version in an HTML comment near the top of the file:

```
<!-- pane skill vX.Y.Z -->
```

The relay you talk to publishes its own version of this skill at
`GET /skills/pane/SKILL.md/version`. **At session start, check whether your
local copy is behind, and if so refresh it.**

The check is a short shell snippet:

```sh
LOCAL_VER=$(grep -m1 -oE '<!-- pane skill v[0-9]+\.[0-9]+\.[0-9]+' <path-to-your-local-skill> | grep -oE '[0-9]+\.[0-9]+\.[0-9]+$')
REMOTE_VER=$(pane skill version --plain)
# If the relay is on an old image that lacks a version comment, the probe
# returns "0.0.0". Don't clobber a newer local copy with the older relay
# skill — skip the update and proceed with what's local.
if [ "$REMOTE_VER" = "0.0.0" ]; then
  : # nothing to do
elif [ "$LOCAL_VER" != "$REMOTE_VER" ]; then
  pane skill show > <path-to-your-local-skill>   # overwrites with the relay's current skill
fi
```

Where `<path-to-your-local-skill>` is wherever YOUR runtime stores the pane
skill (e.g. `~/.claude/skills/pane/SKILL.md` for Claude Code,
`~/.cursor/rules/pane.mdc` for Cursor, the relevant section of
`~/.codex/AGENTS.md` for Codex / Gemini-style concatenated files).

The two `grep`s above are intentionally strict:

- `-m1` stops at the first match in the file, so prose mentions of the
  pattern (this very section!) don't double-count.
- `[0-9]+\.[0-9]+\.[0-9]+` only matches a real semver triple, so a
  literal `<!-- pane skill vX.Y.Z -->` in documentation is skipped.

The strict matcher does NOT accept prerelease tags (e.g. `1.0.0-rc1`).
If we ever ship those, both this snippet and the relay's parser need a
matching update.

Rules:

- If the local file has no `<!-- pane skill v... -->` comment, treat it as
  stale and run `pane skill show > <path>`.
- If `REMOTE_VER` is `0.0.0`, skip the update — the relay is on an old
  image without a version comment, and clobbering your (presumably newer)
  local copy with that would be a downgrade. The snippet above guards
  this; if you're rolling your own check, do the same.
- If the network is unreachable or `pane skill version` fails, **do not
  update** — proceed with the local skill you have. Skipping a check is
  always safer than half-writing the file.
- Don't loop. Check once at session start; if you've already refreshed in
  this session and it's still mismatched, stop and surface the error to
  the human.
- If you've hand-edited the local skill (added your own notes), save your
  changes first — `pane skill show > <path>` is a clobbering write.

## Discover the CLI with `--help`

**Before using a command, run its help.** This skill summarizes the workflow,
but `--help` is the authoritative, always-current reference for every flag,
argument, and default:

- `pane --help` — the command list and global options.
- `pane <command> --help` — every flag and option for that command, e.g.
  `pane session create --help`, `pane session watch --help`, `pane session send --help`,
  `pane agent register --help`.

If a command errors or you are unsure of an option name, **run `--help`
instead of guessing** — the CLI is self-documenting and the help text reflects
the installed version, which this skill may not.

### If `pane` exits 75 ("CLI upgrade required")

The relay you're talking to needs a newer `@paneui/cli` than you have
installed. The CLI signals this with **exit code 75** (`EX_TEMPFAIL`) and a
stderr message that starts with `pane: this relay requires @paneui/cli >=
<version>`. If that message includes a `To upgrade: <command>` line, the
command is correct for how `pane` was installed on this machine — there's
nothing to guess.

What to do, in this order:

1. **Run the printed upgrade command once.** If no command is printed (the
   message says "vendored" or "unknown" install), stop and ask the human to
   bump `@paneui/cli` — don't try to install one yourself.
2. **Re-run your original `pane` command once.** If it succeeds, continue.
3. **If it still fails with exit 75 after one upgrade + retry**, stop and
   surface the error to the human. Do not loop — repeated upgrade attempts
   in the same session are a bug, not a recovery strategy.

## Registering

If you weren't handed an API key, provision one yourself — **once** — with:

```sh
pane agent register --name "<short-descriptive-agent-name>"
```

Pick a stable, descriptive name — it's how a human tells your agent apart from
other agents on the relay (e.g. `claude-code-lalit-macbook`, `ci-pr-review-bot`,
`telegram-helper`). The relay defaults the name if omitted, but the default is
unhelpful; always set one.

Self-hosters add `--url "$PANE_URL"` (or set `PANE_URL`) to target a
non-hosted relay.

Whether `pane agent register` works depends on the relay's `REGISTRATION_MODE`:

- `closed` (the default) — the endpoint returns 404. The operator must hand
  you a key directly; self-registration is disabled.
- `secret` — pass the operator-shared registration secret with `--secret <s>`
  or the `PANE_REGISTER_SECRET` env var. A missing/wrong secret is a 401.
- `open` (the hosted relay's mode) — public; `pane agent register --name <name>`
  works with no secret.

On success this calls the relay's `POST /v1/register`, mints an agent + API
key, and saves the key and relay URL to the CLI config file
(`${XDG_CONFIG_HOME:-~/.config}/pane/config.json`, mode 0600). After that,
every other command picks the key up from that file automatically — no env
vars needed.

- The key is not printed by default. Pass `--print-key` if you need it echoed.
- Run it just once; re-running mints a fresh agent each time.
- The relay rate-limits `/v1/register` per IP; if you hit it, `pane agent register`
  fails with `rate_limited` — wait and retry.

## Artifacts and sessions — the model

An **artifact** is a reusable UI template: the HTML, an optional event schema,
and an optional input schema. A **session** is one _use_ of an artifact — one
context, one human, one event log, one TTL. Many sessions per artifact.

The reusable artifact is the unit you should think in. **Start every task with
`pane artifact list`** (or `pane artifact search <keywords>`) to see what
already exists — a previous run may have authored exactly the UI you need. The
intended flow is: author an artifact **once** with `pane artifact create`, then
instance it **many times** with `pane session create --artifact-id <slug>` — no HTML
re-sent, no regeneration. Per-instance data (the "PR metadata" that makes the
same PR-review page show _this_ PR) rides in `--input-data`; the page reads it
as `window.pane.inputData`.

There are two ways to give `pane session create` an artifact:

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
2. **If yes** — use it: `pane session create --artifact-id <id|slug>` (optionally
   `--input-data` for this instance's data). Inspect it first with
   `pane artifact show <id|slug>` — the `description` and each version's
   `input_schema` tell you what it does and what data it needs. Done — no HTML
   written.
3. **If nothing fits** — only then author. If the UI is genuinely a one-off,
   use the inline `pane session create --artifact ...` form. If it is something you (or
   the operator) will want again, register it: `pane artifact create` — so the
   next session can find and reuse it.

A reusable artifact is only reusable if you look for it. Skipping the search
makes the whole feature dead weight.

### …and name what you author

The flip side: search only works on metadata **you populate when you author**.
When you call `pane artifact create`, every metadata field is optional, but
each one you skip is a future search query that comes back empty.

Populate, even briefly:

- **`--name`** — human-readable label. "PR Review", not "Form 1".
- **`--slug`** — a short, durable kebab-case handle. Record it; you (or any
  future session) can later use `pane session create --artifact-id <slug>` with no
  search at all. Without a slug, the only handle is the relay-assigned id —
  which is not memorable and not stable in your prompt context.
- **`--description`** — what a future you reads to decide "is this the one I
  want?" *before* fetching the HTML. Cover three things: what the artifact
  is for, what the human can do on it (which events it emits), and what
  `input_data` shape it expects. As long as that fits, length doesn't
  matter — overly terse here costs every future reader, overly long here
  costs nothing.
- **`--tags`** — a few short keywords. `--tags pr,review,code` makes
  `pane artifact search "review"` and `… "code"` both find it.
- **`--input-schema`** — optional JSON Schema for the `input_data` the
  artifact expects. Doubles as documentation: a future you reads it to know
  exactly what shape of data to pass at `pane session create` time.

None of these are required by the relay. All of them are required if you
want this artifact to be findable later. Treat them as a one-time author's
tax that pays back every reuse.

Heuristic for when to bother:

- **One-off shape** (a custom approval for *this specific* deploy, a survey
  you're handing out once) → use the inline `pane session create --artifact …` form,
  skip the metadata.
- **Reusable shape** (a PR review page, a deploy approval, a generic survey
  template) → `pane artifact create` with `--name`, `--slug`, `--description`,
  `--tags` populated. The tokens you save are your next session's.

## The commands

### `pane session create` — start a session

Reference an existing artifact (the reuse path — see "Search before you
generate" above):

```sh
pane session create --artifact-id pr-review --input-data ./pr-42.json --ttl 600
```

Or inline a one-off artifact:

```sh
pane session create --artifact ./form.html --event-schema ./schema.json \
  --title "Quick poll" --ttl 600
```

- `--title <text>` — the human's browser tab title for this session (max 80
  chars, single line). Set a descriptive, per-session value so a human with
  several panes open can tell tabs apart. **Required, with one exception:**
  reference-form sessions (`--artifact-id`) against a named artifact fall back
  to the artifact's `name`. So `pane artifact create --name "PR Review"` +
  `pane session create --artifact-id pr-review` is fine; `pane session create --artifact …`
  (inline) always needs `--title`.
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
  `pane session create --artifact-id pr-review` with no search at all.
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
  `pane session send` data against it and rejects mismatches.
- `emittedBy` — who may emit this type: `"page"` (the human's UI, via the
  `pane.emit` bridge) and/or `"agent"` (you, via `pane session send`). Emitting a
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

- Omit `--event-schema` on `pane session create --artifact ...` or `pane artifact create` to
  make a view-only artifact. The CLI sends no event schema.
- A view-only session declares an **empty event vocabulary, strictly enforced**.
  Every `page`/`agent` emit is rejected `422 unknown_event_type` — `pane.emit`
  in the page and `pane session send` from the agent both fail. There is no event type
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
  `assistant.reply` you sent via `pane session send`).
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
`pane session send --data` — is in **`ev.data`**. So an event sent with
`pane session send --type assistant.reply --data '{"title":"...","message":"..."}'`
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
<!--
  Note: the artifact runs in a sandboxed iframe. The relay grants `allow-forms`
  alongside `allow-scripts` so a real <form> + Enter-to-submit works, but the
  iframe has no `allow-same-origin`, so a form's *native* submission can't
  reach any origin anyway. Either pattern is fine — we use a plain
  <button type="button"> + click handler below so the example doesn't depend
  on form-submission semantics at all.
-->
<div id="f">
  <input id="name" placeholder="Your name" required />
  <input id="rating" type="number" min="1" max="5" required />
  <button type="button" id="submit">Submit</button>
</div>
<p id="status"></p>

<!-- The agent's reply renders here -->
<section id="reply" hidden>
  <h2 id="reply-title"></h2>
  <p id="reply-msg"></p>
</section>

<script>
  // The agent pushes a rich reply with
  //   pane session send --type assistant.reply --data '{"title":"…","message":"…"}'
  // `ev` is the envelope; the payload is `ev.data`.
  pane.on("assistant.reply", (ev) => {
    const { title, message } = ev.data;
    // .textContent — never .innerHTML — so agent text can't inject markup.
    document.getElementById("reply-title").textContent = title;
    // `white-space: pre-wrap` (above) keeps `\n` in `message` as line breaks.
    document.getElementById("reply-msg").textContent = message;
    document.getElementById("reply").hidden = false;
  });

  document.getElementById("submit").addEventListener("click", async () => {
    const name = document.getElementById("name").value;
    const rating = Number(document.getElementById("rating").value);
    // Basic validation — the sandbox doesn't give us native form validation
    // here because we're not using <form>'s submit pipeline.
    if (!name || !(rating >= 1 && rating <= 5)) return;
    // Emit the terminal event — this is what `pane session watch --type` waits for.
    // Await it: pane.emit resolves only once the relay has accepted the
    // event, and rejects if delivery fails. Only show "Sent" after that.
    await pane.emit("form.submitted", { name, rating });
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
  the `--type` you later `pane session watch` for. Above: `form.submitted`.
- A handler's argument is the **envelope** — read the payload from `ev.data`,
  and render its individual fields with `.textContent` into real elements.
- `pane` is ready by the time inline `<script>` runs — no need to wait for an
  init event.
- No external assets that need the network (CDN scripts, remote fonts/images):
  the sandbox CSP blocks them. Inline everything, or use data URIs.
- Keep the artifact self-contained — it's one HTML document.

### `pane session watch <id>` — wait for the answer

`pane session watch` holds a WebSocket and prints **one compact JSON object per line**
to stdout, flushing after each. This is the key command — it's how you wait for
the human.

```sh
pane session watch ses_xxxx --type form.submitted
```

- `--type <t[,t2,…]>` — exit 0 after the first event whose type is in this
  comma-separated set. Use this to wait for the human's terminal action.
  Pass multiple types when you want to exit on any of several outcomes
  (e.g. `--type form.submitted,form.cancelled`).
- `--filter-type <t[,t2,…]>` — restrict the STDOUT stream to events whose
  type is in this set. `system.*` events (participant joined, session
  expired) and the terminal `_closed` line always pass through so the
  harness still sees lifecycle signals. `--type` controls the EXIT
  condition; `--filter-type` controls the OUTPUT. Combine them
  (`--type X --filter-type X`) for "stream only X events and exit on
  the first one".
- `--once` — exit 0 after the very first event.
- `--timeout <seconds>` — wall-clock max wait. Exits with code `ws_timeout`
  if the awaited terminal condition (`--once`, `--type`, session close)
  hasn't happened by then. Frames arriving do NOT reset the timer — this
  is the budget for "give up on the human", not an idle detector. Use it
  so you don't wait forever for a human who never acts.
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

### `pane session show <id>` — snapshot, optionally long-polled

```sh
pane session show ses_xxxx                          # snapshot, returns immediately
pane session show ses_xxxx --since <next_cursor>    # only events past the cursor
pane session show ses_xxxx --since <next_cursor> --wait 30
```

Prints `{ meta, events, next_cursor }` without holding a WebSocket. Two
modes:

- **Default (non-blocking).** Returns whatever exists right now. Use for
  a one-off "is the session still alive?" check.
- **`--wait <secs>` (long-poll).** The relay holds the request open for
  up to that many seconds — capped server-side at 30 — and returns as
  soon as a new event arrives. Use this for **headless polling agents
  that can't keep a WebSocket open** (cron, FaaS, slow links): call,
  re-call with the previous `next_cursor` as `--since`, repeat. Higher
  latency per round-trip than `pane session watch` but no long-lived connection.

Choose `watch` (streaming) when you can hold a process; choose
`state --wait` (polling) when you can't.

### `pane session send <id>` — emit your own event

```sh
pane session send ses_xxxx --type assistant.reply \
  --data '{"title":"Got it","message":"Thanks — your rating is recorded."}'
```

`--data` is a file path or inline JSON. The event type must exist in the schema
with `agent` in its `emittedBy`. Use this to update the UI live while the human
works.

### `pane session delete <id>` — close a session

```sh
pane session delete ses_xxxx
```

Closes the session and tears it down (`DELETE /v1/sessions/:id`). Idempotent —
re-deleting an already-closed session is a no-op. Use it to clean up a session
you are done with rather than waiting for its TTL to expire.

### `pane session list` — enumerate your sessions

```sh
pane session list                                  # default --status=open
pane session list --status all
pane session list --status closed --limit 100
pane session list --artifact-id pane-pitch-deck    # filter by named artifact
pane session list --cursor <opaque>                # next page
```

Lists your agent's sessions, newest first. The response is intentionally
LEAN: each row carries `active_human_participants` (a count of non-revoked
human URLs on that session) but NOT the full participant array — agents
with many sessions × many humans should not pay that bandwidth on every
list call. To see the participants themselves (including revoked rows),
call `pane session participant list <session-id>`.

The response also carries NO secrets: no participant tokens, no callback
URL, no metadata or input_data.

**Load-bearing caveat — participant tokens are unrecoverable.** The relay
stores only the hash of each participant token; the plaintext URL is returned
exactly once in the `pane session create` response and **cannot be retrieved
later**. If you lost a URL, neither `pane session list` nor `pane session
participant list` will return it; instead, use `pane session participant new`
to mint a fresh URL on the still-alive session.

### `pane session participant list|new|revoke` — manage URLs on a live session

```sh
# Find the participant ids on one session.
pane session participant list ses_abc123

# Lost the URL but the session is still alive — mint a new entry door.
pane session participant new ses_abc123 | tee -a ~/.pane-sessions.jsonl

# Invalidate a URL you no longer want usable.
pane session participant revoke ses_abc123 p_xyz
```

Three primitives that together replace `pane session delete + pane session
create` for the lost-URL case (which would destroy the session's event log,
artifact pin, and created_at — `participant new` preserves all of that).

- `pane session participant list <session-id>` — returns the full
  participant array for one session (active AND revoked rows). Each row has
  `participant_id` (the revoke handle), `kind`, `token_prefix` (non-secret
  correlator like `tok_h_BUcx`), `joined_at`, and `revoked_at`. This is the
  step you use to find a participant_id to pass to `revoke`.
- `pane session participant new <session-id>` — mints a fresh human URL on
  an existing session. Returns `{ participant_id, kind, token, url,
  created_at }` exactly ONCE. Save the response (pipe to a JSONL log) before
  delivering the URL.
- `pane session participant revoke <session-id> <participant-id>` —
  invalidates one URL. The session's other URLs (and your own websocket)
  are untouched. Idempotent: running revoke twice still returns success.
  **Caveat:** in this version, existing WebSocket connections held under
  the revoked token are NOT actively kicked; only new HTTP and WS
  connections under that token fail.

**Recovery recipe** when you dropped the create response:

```sh
pane session list                                          # find session_id
pane session participant list ses_abc123                   # find participant
                                                           #   ids on that
                                                           #   session
pane session participant new ses_abc123 | tee -a ~/.pane-sessions.jsonl
# use the new url; the old one is still valid until you revoke
pane session participant revoke ses_abc123 p_xyz           # optional —
                                                           #   invalidate
                                                           #   the old URL
```

### `pane config` — inspect the resolved config

```sh
pane config
```

Prints the relay URL and API-key prefix the CLI is currently using, where each
came from (`flag` / `env` / `store`), and the config-file path. Makes **no
network call**. The full API key is never printed — only a masked prefix. Run
it when a command fails with `config_error` to see what is actually set.

### `pane agent logout` — clear the saved credentials

```sh
pane agent logout
```

Deletes the locally-saved relay URL + API key from the CLI config file. This is
**local only** — it does not revoke the key on the relay; the key still works
if used again. To actually revoke the key, use `pane key revoke`.

### `pane key` — inspect or revoke your API key

```sh
pane key list                 # show your agent's key info (one key per agent)
pane key revoke --yes         # REVOKE your own key — a self-destruct
```

A pane agent has exactly one API key. `keys list` shows its metadata
(`key_prefix`, created/last-used, etc.) — never the full key. `keys revoke`
**permanently revokes your own key**; it stops working immediately and you
would have to `pane agent register` again. It refuses to run without `--yes`.

### `pane taste` — remembering UI preferences across sessions

```sh
pane taste get                              # read current notes (JSON)
echo "- denser tables\n- no rounded corners" | pane taste set
pane taste set --file ./taste.md            # read from a file instead of stdin
pane taste clear --yes                      # forget everything
```

`taste` is a small markdown blob — **your** agent's accumulated *presentation
taste*: how the human you serve likes pane artifacts to look. The intended
loop is:

1. **Before generating an artifact**, run `pane taste get` and fold the
   `taste` field into the prompt that authors the HTML. Past feedback ("dark
   header", "no emoji", "tighter spacing") shapes the new artifact.
2. **When the human gives presentation feedback**, run `pane taste get`,
   merge the new guidance into the existing notes *in your prompt*, then
   write the WHOLE updated blob back with `pane taste set`. Don't append
   blindly — taste set is whole-blob replace on purpose, so the notes stay
   curated and don't rot into a transcript.
3. **Keep entries about presentation only** — colours, density, component
   choices, layout. Project context, todos, and per-session state belong
   somewhere else (your own memory, the session's events, etc.).

Keyed today by the calling agent's API key — per-agent, not per-human (pane
v1 has no first-class human identity yet). Expect this to move to per-human
later; the CLI surface won't change.

### `pane feedback` — product feedback to pane's maintainers

```sh
pane feedback create --type bug --message "watch dropped at 30s"
echo "long note" | pane feedback create --type note --message -
pane feedback list
```

Bugs, feature requests, or notes about **pane itself** (CLI, relay, docs,
this skill) — not about the human's task.

**Prefer GitHub Issues** at `github.com/aerolalit/paneui` for bugs and
features — that's the maintainers' primary triage. Use `pane feedback`
only when you can't reach GitHub in this run (no `gh`, no auth, headless).
Notes are fine to send directly.

`--type` ∈ {`bug`, `feature`, `note`}. `--message -` reads stdin.
`--session-id` is optional. No reply channel — don't use this for anything
you need an answer to, or for the human's answer to a session question
(use events). UI preferences belong in `pane taste`, not here.

### `pane blob` — binary attachments (images, PDFs, etc.)

```sh
# Upload a file. Default scope is "agent" (reusable across the agent's sessions).
pane blob upload --file ./chart.png

# Session-scope (dies with the session; cheaper to GC):
pane blob upload --file ./hero.jpg --scope session --session-id ses_xxx

# Artifact-scope (reusable across every session using the artifact):
pane blob upload --file ./icon.svg --scope artifact --artifact-id <id>

# Mint a /b/<token> URL the human can fetch directly (no agent API key):
pane blob mint-token <blob_id>             # default TTL: 24h agent / session-TTL / 30d artifact
pane blob mint-token <blob_id> --once      # self-deletes on first GET

# Revoke a token (incident response — see docs/RUNBOOK-LEAKED-TOKEN.md):
pane blob revoke-token <blob_id> <token_id>

# Inspect / download / delete:
pane blob show <blob_id>
pane blob download <blob_id> --out ./out.png
pane blob delete <blob_id>
```

**One-shot upload + emit** — most agents emit events that REFERENCE blobs
rather than embed them. Use `pane send --blob` to do both in one call:

```sh
# Uploads ./chart.png as a session-scope blob, then sends an event
# whose data is { blob: <BlobRef> } into the session.
pane send <session-id> --type chart.update --blob ./chart.png
```

The session's event schema should declare a blob field with
`format: pane-blob-id`:

```json
{
  "events": {
    "chart.update": {
      "emittedBy": ["agent"],
      "payload": {
        "type": "object",
        "properties": {
          "blob": {
            "type": "object",
            "properties": {
              "blob_id": { "type": "string", "format": "pane-blob-id" }
            },
            "required": ["blob_id"]
          }
        },
        "required": ["blob"]
      }
    }
  }
}
```

Pages handle the event by reading `ev.data.blob.url` and stuffing it in
`<img>` / `<iframe>` / wherever the blob is meant to render:

```js
pane.on("chart.update", (ev) => {
  document.getElementById("chart").src = ev.data.blob.url;
});
```

**Default limits** (the hosted relay): 5 MB per blob, 500 MB total per
agent. Adjust `BLOB_*` env vars on self-host. See `docs/BLOB_BACKENDS.md`
for the backend matrix, `docs/CAPABILITY-URLS.md` for the `/b/<token>`
threat model, and `docs/SECURITY-POLYGLOTS.md` for the upload-side
defence (sharp normalisation + EXIF strip; SVG is passthrough — keep it
out of `BLOB_MIME_ALLOWLIST` if your surface renders SVGs inline).

### Human file uploads in a pane

A human inside a rendered pane can upload a file BACK to the relay via
`window.pane.uploadBlob(file, options?)`. The returned `BlobRef` is
suitable for stuffing into an event payload — the agent receives it and
can `pane blob download` (or mint a `/b/<token>` URL) to read the bytes.

**1. Declare the event in your schema with a blob field.**

```json
{
  "events": {
    "photo.attached": {
      "emittedBy": ["page"],
      "payload": {
        "type": "object",
        "properties": {
          "blob": {
            "type": "object",
            "properties": {
              "blob_id": { "type": "string", "format": "pane-blob-id" }
            },
            "required": ["blob_id"]
          }
        },
        "required": ["blob"]
      }
    }
  }
}
```

**2. Inside the artifact HTML, wire a file input to `pane.uploadBlob` +
`pane.emit`.**

```html
<input type="file" id="picker" accept="image/jpeg,image/png">
<button id="send" disabled>Upload</button>
<div id="status"></div>
<script>
  const picker = document.getElementById("picker");
  const sendBtn = document.getElementById("send");
  const status = document.getElementById("status");
  picker.addEventListener("change", () => {
    sendBtn.disabled = !picker.files?.length;
  });
  sendBtn.addEventListener("click", async () => {
    sendBtn.disabled = true;
    status.textContent = "uploading...";
    try {
      // Hands the File to the shell over postMessage; the shell POSTs
      // to /s/<participantToken>/blobs and returns the BlobRef.
      const blob = await window.pane.uploadBlob(picker.files[0]);
      await window.pane.emit("photo.attached", { blob });
      status.textContent = "uploaded.";
    } catch (e) {
      // e.code is the relay's error code (e.g. "blob_size_exceeded",
      // "mime_disallowed"). Branch on it to render a useful message.
      status.textContent = "failed: " + (e.code || e.message);
      sendBtn.disabled = false;
    }
  });
</script>
```

**3. Agent-side, watch for the event and read the bytes.**

```sh
# Wait for the human's upload event.
EVENT=$(pane watch "$SID" --type photo.attached)
BLOB_ID=$(echo "$EVENT" | jq -r .data.blob.blob_id)

# Download the bytes.
pane blob download "$BLOB_ID" --out ./uploaded.jpg
```

Uploads are pinned to scope=`session`: they cascade-delete with the
session, count against the AGENT's quota (not the participant), and
run through the same MIME-sniff + polyglot-defense + EXIF-strip
pipeline as `pane blob upload`. See `docs/CAPABILITY-URLS.md` for the
threat model.

### Lazy image fetch in a pane

The reverse direction — the **agent** has an image (e.g. a chart it
generated, an attachment downloaded from somewhere, output of an image
pipeline) and wants the pane to render it. There are two ways:

1. **Inline the bytes in the event payload as `data:image/...;base64`.**
   Don't. The iframe CSP allows it, but: it costs 33% on base64, the
   bytes get duplicated on disk (encrypted blob store + event row), the
   bytes replay over WebSocket on every reconnect, and a 1 MB image
   won't fit under `MAX_EVENT_DATA_BYTES` (default 64 KB). The whole
   point of blob storage is to avoid this.

2. **Upload as a blob, send just the `BlobRef` on the event, fetch
   lazily in the pane.** This is the preferred shape. The pane runs
   `await window.pane.downloadBlob(blob_id)` and gets a real browser
   `Blob` it can render via `URL.createObjectURL(blob)`.

**1. Declare the event with a blob field (same shape as uploads).**

```json
{
  "events": {
    "image.delivered": {
      "emittedBy": ["agent"],
      "payload": {
        "type": "object",
        "properties": {
          "blob": {
            "type": "object",
            "properties": {
              "blob_id": { "type": "string", "format": "pane-blob-id" }
            },
            "required": ["blob_id"]
          }
        },
        "required": ["blob"]
      }
    }
  }
}
```

**2. Agent uploads the bytes and emits a thin event with just the BlobRef.**

```sh
# Upload — get back a BlobRef bound to the session.
REF=$(pane blob upload ./weather-chart.png --session "$SID" --json)
BLOB_ID=$(echo "$REF" | jq -r .blob_id)

# Emit an event that only carries the id — no inline bytes.
pane send "$SID" image.delivered --data "{\"blob\":{\"blob_id\":\"$BLOB_ID\"}}"
```

**3. Inside the artifact, lazy-fetch the bytes and render.**

```html
<img id="chart" alt="weather chart">
<script>
  window.pane.on("image.delivered", async (ev) => {
    try {
      // window.pane.downloadBlob() returns a real browser Blob. The iframe
      // CSP allows blob: URLs in img-src, so createObjectURL is safe.
      const blob = await window.pane.downloadBlob(ev.data.blob.blob_id);
      document.getElementById("chart").src = URL.createObjectURL(blob);
    } catch (e) {
      // e.code is the relay's error code (e.g. "blob_ref_not_accessible",
      // "participant_token_invalid"). Branch on it to render a useful
      // fallback.
      console.warn("could not fetch image:", e.code || e.message);
    }
  });
</script>
```

The shell brokers the fetch with the participant token; the bytes are
decrypted by the relay (when `BLOB_ENCRYPT_AT_REST` is on) and arrive
as a fresh Blob the iframe can render. **The blob must be referenced
from this session** — either via an event the agent emitted or via the
session's initial `inputData`. A participant token cannot enumerate
arbitrary blobs the agent owns. See `docs/CAPABILITY-URLS.md` for the
full trust model.

## The watch → Monitor pattern

`pane session watch` is built to be a **monitored subprocess**. It blocks until the
awaited event lands, prints it, and exits 0 — so a supervising harness can wake
you with the result.

- **Claude Code Monitor tool**: launch `pane session watch <id> --type form.submitted`
  as a monitored process. When the human submits, the line is printed, the
  process exits 0, and you are re-invoked with the event payload. No polling.
- **Shell pipeline**: `pane session watch <id> | while read -r line; do ...; done`.
- **`--filter-type` for clean stdout**: `pane session watch <id> --filter-type comment.added`
  (built-in equivalent of `jq -c 'select(.type=="comment.added")'`; `system.*`
  lifecycle events still pass through so the harness sees them).
- **Polling alternative**: loop `pane session show <id> --since <cursor> --wait 30`
  for environments that can't hold a WebSocket (cron, FaaS, slow links).

## Typical round trip

> Tip: run `pane <command> --help` first if you're unsure of any flag below —
> the help text is authoritative.

```sh
# 1. create the session
OUT=$(pane session create --artifact ./review.html --event-schema ./review-schema.json --ttl 900)
SID=$(echo "$OUT" | jq -r .session_id)
URL=$(echo "$OUT" | jq -r '.urls.humans[0]')

# 2. deliver $URL to the human over your own channel (Telegram/Slack/email)

# 3. wait for the human's submit — run as a monitored process
pane session watch "$SID" --type review.submitted
#    -> prints the review.submitted event as a JSON line, exits 0

# 4. act on the event's `data`
```
