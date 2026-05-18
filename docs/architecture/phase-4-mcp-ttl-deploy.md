# Phase 4: TTL sweeper, CLI, deploy, dogfood

## Scope

In:
- The TTL sweeper (periodic cleanup + lazy expiry on read).
- The `pane` CLI (`pane-cli`, bin `pane`) and its four commands: the first
  client wrapper.
- The npm-workspaces monorepo layout (`@pane/core`, `@pane/relay`, `pane-cli`).
- The Dockerfile + `.dockerignore` + single-container deploy story.
- The `claudeclaw` dogfood: wiring `pane watch` into a real claw instance and
  doing one genuine round trip.
- The hosted-lite demo instance.
- README polish + the 30-second demo clip + flipping the repo public + MIT license.

Out:
- The LangChain tool wrapper (v2).
- The proper hosted product: accounts, dashboard, billing, SLA, teams, roles,
  analytics (v2 / `/ee/`).
- SSE as a retrieval mode (v2).
- Multi-process sweeper coordination (v1 is single-process; flag for `/ee/`).

## Monorepo layout

Phase 4 restructured the repo into an npm-workspaces monorepo. The root
`package.json` is `private`, declares `workspaces: ["packages/*"]`, and proxies
the common scripts (`build`, `typecheck`, `test`) to the workspaces.

```
pane/
├── package.json            workspace root
├── packages/
│   ├── core/               @pane/core — relay HTTP + WS client; pure,
│   │                       framework-free (deps: zod + ws)
│   ├── relay/              @pane/relay — the server: src/, prisma/,
│   │                       Dockerfile, .dockerignore
│   └── cli/                pane-cli — the published CLI; bin "pane"
│                           (deps: @pane/core + zod)
└── docs/
```

- **`@pane/core`** holds the relay API contract: the `PaneClient` HTTP helper
  (`call()` + typed `createSession` / `getSession` / `getEvents` / `sendEvent`)
  and `openStream` — a WebSocket client for `WS /v1/sessions/:id/stream` with
  replay-on-connect. It is pure: no argv, no `process.env`, no MCP. Any client
  (the CLI, a future LangChain tool) builds on it.
- **`@pane/relay`** is the unchanged server — all of the former top-level
  `src/` and `prisma/`, the Dockerfile and `.dockerignore`. Build, run, and the
  full test suite behave exactly as before; only paths moved.
- **`pane-cli`** is the published package: `npm i -g pane-cli` gives you the
  `pane` binary.

## TTL sweeper

- In `packages/relay/src/index.ts`: `setInterval` every `TTL_SWEEP_SECONDS`
  (default 60; `0` disables), with a little jitter, running
  `prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })`. The
  `Event` and `Participant` rows cascade away (`onDelete: Cascade`). Log a
  `debug` line with the count.
- Plus lazy expiry: `GET /v1/sessions/:id` already (phase 2) reports
  `status: "closed"` when `expiresAt < now` even if the row is still present, so
  a slow sweep never lies.
- Multi-process (the hosted build): only one process should sweep. A Postgres
  advisory lock, or `SELECT ... FOR UPDATE SKIP LOCKED`, or a dedicated worker.
  **Out of scope for v1** (single-process); note it for `/ee/`.
- **DECIDED**: interval + lazy-expiry-on-read; interval disable-able via env.
  Sweeper behaviour is unchanged by the monorepo move.

## The `pane` CLI

`pane-cli` replaces the originally-planned MCP server. The motivation: an MCP
server only helps MCP hosts, and it pulls in the `@modelcontextprotocol/sdk`
dependency and a stdio-transport lifecycle. A CLI that emits **JSON on stdout**
is harness-agnostic — it works for an MCP host, a cron agent, a shell pipeline,
a CI job, or Claude Code's process tools, with nothing to install but one
binary. The relay API contract the MCP server encoded (the `call()` helper +
the three operations) now lives in `@pane/core` and is reused unchanged.

- **Distribution**: published as `pane-cli`, `bin: { "pane": "dist/index.js" }`,
  so `npm i -g pane-cli` (or `npx pane-cli`) gives the `pane` command.
- **It is a client of the relay's HTTP / WS API.** It holds `PANE_URL` and
  `PANE_API_KEY` (env; `--url` / `--api-key` override per invocation) and calls
  `POST /v1/sessions`, `GET /v1/sessions/:id`, `GET /v1/sessions/:id/events`,
  `POST /v1/sessions/:id/events`, and `WS /v1/sessions/:id/stream`. It does NOT
  embed the relay.
- **Output is JSON by default.** stdout is machine-readable; errors go to
  stderr as `{"error":{"code","message"}}` with a non-zero exit. Every command
  has a concise `--help`; a model that has never seen `pane` self-serves from it.

### Command surface

Four commands.

**`pane create`** — wraps `POST /v1/sessions`. Flags for the artifact, schema,
TTL, participant count, metadata, and webhook callback. `--artifact` and
`--schema` (and `--metadata` / `--callback`) accept either a file path or an
inline literal — inline JSON for the structured ones, inline HTML for the
artifact body. Prints `{ session_id, urls, tokens, expires_at }`. The caller
delivers `urls.humans` to the human(s) over its own channel (Telegram, Slack,
email); `tokens.agent` is the bearer for the WS stream.

**`pane state <id>`** — non-blocking. Fetches session metadata
(`GET /v1/sessions/:id`) plus the event log (`GET /v1/sessions/:id/events`,
optionally `--since <cursor>`) and prints `{ meta, events, next_cursor }`. For
agents that don't want to hold a connection open.

**`pane send <id>`** — `POST`s an agent event (`--type` + `--data`, with
optional `--causation-id` / `--idempotency-key`) into the session. The relay
stamps the author from the API key; identity cannot be spoofed, and the event
type must exist in the schema with `agent` in its `emittedBy`.

**`pane watch <id>`** — long-lived. Holds a WebSocket via `@pane/core`'s
`openStream` (replay-on-connect, then live). Prints **one compact JSON object
per line** to stdout, flushing after each. On session close it prints a final
`{"type":"_closed"}` line and exits 0. Flags:
- bare — run until `SIGINT`;
- `--once` — exit 0 after the first event;
- `--type <t>` — exit 0 after the first event of that type.

This JSON-lines stdout is the core contract. In v1, "submit" is not magic; the
agent tells `watch` which event type to wait for (`--type review.submitted`).
The artifact's schema declares what that type is.

### `pane watch` → Claude Code Monitor / any pipe-reader

`pane watch` is built to be a monitored subprocess. The general pattern: run
`pane watch <id> --type <terminal-event>` as a long-running process; a
supervising harness re-invokes the model (or runs the next step) when the
matching line lands on stdout, because the process exits 0 at that point.

- **Claude Code Monitor tool**: launch `pane watch <id> --type form.submitted`
  as a monitored process. When the human submits, the line is printed, the
  process exits 0, and the harness wakes the model with the event payload.
- **Shell**: `pane watch <id> | while read -r line; do ...; done` — react to
  every event as it arrives.
- **`jq`**: `pane watch <id> | jq -c 'select(.type=="comment.added")'`.
- **Polling alternative**: where a held connection is awkward, loop
  `pane state <id> --since <cursor>` instead.

### CLI config & errors

- Env: `PANE_URL` (the relay base URL), `PANE_API_KEY` (the agent key). Either
  can be overridden per invocation with `--url` / `--api-key`. A command that
  needs the relay refuses to run without both, with a `config_error`.
- Relay errors surface verbatim as the relay's error envelope on stderr
  (`{"error":{"code","message","details"}}`) with exit 1 — `code` is the relay's
  own (`author_not_allowed`, `payload_too_large`, `schema_violation`,
  `not_found`, …), so callers can branch on it. Network failures surface as
  `fetch_error`.

## Dockerfile / deploy

The relay ships from `packages/relay/Dockerfile`. **The build context is the
monorepo root** (it needs the root `package-lock.json` for `npm ci`), so build
with an explicit `-f`:

```
docker build -f packages/relay/Dockerfile -t pane .
```

Multi-stage, `node:20-slim` (Debian, glibc; matters for Prisma's query-engine
binary; `debian-openssl-3.0.x` is the default and works on slim).
**DECIDED**: slim, not Alpine. (Alpine = musl = needs
`binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` and more surprises;
document for anyone who insists, but ship slim.)

The Dockerfile installs only the `@pane/relay` workspace
(`npm ci --workspace @pane/relay --include-workspace-root`), generates the
Prisma client, compiles `dist/`, and in the runtime stage carries `dist/`, prod
`node_modules`, the generated Prisma client, and `prisma/migrations/`. The
runtime working directory is `/app/packages/relay`.

Documented run (unchanged):

```
docker run -p 3000:3000 \
  -e PUBLIC_URL=https://pane.example.com \
  -e API_KEY=pane_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  -v pane-data:/app/data \
  ghcr.io/<owner>/pane
```

With no `-e API_KEY`, the container prints a generated key once on first boot
(phase-1 bootstrap); `docker logs` to grab it.

`.dockerignore` (`packages/relay/.dockerignore`): excludes `**/node_modules`,
`**/dist`, `.git`, `data`, `*.db`, `.env*`, `docs`, and the non-relay
workspaces (`packages/cli`, `packages/core`).

## claudeclaw dogfood

Wire `pane` into one `claudeclaw` instance, pointed at a locally-running relay
(or the hosted-lite one). The concrete first use: a heartbeat / agent task that
needs Lalit to pick from options or review something richer than text. The claw
builds an HTML artifact + schema (e.g. one event type `review.commentAdded`
from `["page","agent"]` and one `review.submitted` from `["page"]`), runs
`pane create`, sends Lalit the URL over the existing Telegram channel, then runs
`pane watch <id> --type review.submitted` as a monitored process and acts on
the resulting event when the process exits. Bonus: the claw can `pane send` into
the same session to reply to Lalit's comments live; the schema's
`emittedBy: ["page", "agent"]` is what makes that possible.

This is the "does the round trip actually feel good?" test. Do it before anyone
else touches the project.

## Hosted-lite demo

The same Docker image, run on Azure (Container Apps, on the credits).
`PUBLIC_URL` = the assigned `*.azurecontainerapps.io` (or a cheap domain). For
"people can try it without deploying": `POST /v1/register` is open by default —
anyone can self-register, bounded only by the per-IP `REGISTER_RATE_LIMIT`
sliding window — so the demo instance needs no special config. The shell page
on the demo instance carries a banner: "demo instance. Data may vanish, no SLA,
may change or disappear."

## Acceptance criteria

- **Monorepo**: `npm install` at root resolves the three workspaces;
  `npm run build` / `npm run typecheck` are clean for all three; `npm test`
  runs the relay suite green.
- **Sweeper**: create a session with `--ttl 2`, wait past one sweep interval →
  the session row and its events / participants are gone; `pane state` during
  the gap reports `status: "closed"`.
- **CLI**: against a running relay, `pane create` returns `urls.humans`; a human
  opens one and emits a `review.submitted` event; `pane watch <id> --type
  review.submitted` prints the event as a JSON line and exits 0. `pane state`
  returns the same state without blocking. `pane send` emits an agent event.
- **Docker**: `docker build -f packages/relay/Dockerfile -t pane .` then
  `docker run` with the documented env → relay up, migrations applied,
  `GET /healthz` → 200, a full session round-trip works against the container.
  After `docker restart`, prior data is still there (the volume).
- **claudeclaw**: one real round trip where Lalit answers via the UI and the
  claw acts on the resulting event. Bonus: the claw replies live to one of
  Lalit's comments via `pane send`.
- **hosted-lite**: a second machine (or a stranger) can `POST /v1/register`
  (open, no secret), get a key, create a session, complete it, with
  zero involvement from Lalit.
- **Publish**: repo public, `LICENSE` is MIT, `README.md` has a working
  quickstart and a short demo clip / gif.

## Open decisions

- **hosted-lite registration**: RESOLVED — `/v1/register` is open by default
  and bounded by a per-IP sliding-window rate limiter (`REGISTER_RATE_LIMIT`).
- **Image registry**: GHCR vs Docker Hub for the published image. OPEN, low
  stakes.
- TTL sweeper design (interval + lazy-read), the CLI replacing the MCP server,
  the npm-workspaces monorepo, the four-command surface
  (`create` / `state` / `send` / `watch`), JSON-lines stdout as the contract,
  Docker base (`node:20-slim`): all **DECIDED** above.
- **MCP**: dropped in v1. An MCP-server wrapper around `@pane/core` remains a
  viable later addition for hosts that want native tools, but the CLI covers
  the same agents with less surface. Reconsider in v2 if there is demand.
