# Pane

**A round-trip UI channel between agents and humans.** An agent hands a human a rich interactive UI by URL (no GUI host app needed on either side), captures the human's interactions as structured data, and feeds that data back to the agent (WS, poll, or webhook).

Status: design sketch. No code yet. Full design notes also live in the personal vault at `wiki/projects/pane/pane.md`.

## The problem

Agents can already emit rich output (the "ask Claude for HTML, not Markdown" pattern). But the human's reply is still prose. The agent → human channel is rich, the human → agent channel is a text box. Pane closes the loop: agent renders a UI (form, picker, doc-review view, dashboard, sketchboard), human manipulates it, every interaction emits structured data, the agent retrieves it (or pushes its own updates back into the same UI). The human "answers" by using a UI, not by typing.

This matters most for agents that live **outside a GUI host app**: cron agents, Slack/Telegram bots, CI agents, headless servers, personal-agent setups. None of them can use MCP Apps (which needs a host app to render the UI). Pane needs neither a host app nor a public address on the agent's side; the agent only makes outbound calls to the relay.

## How it works

1. Agent generates an HTML page (the UI it wants the human to act on).
2. Agent → `POST /sessions` with `{html, schema, ttl}` → gets `{session_id, url}`.
3. Agent sends `url` to the human over whatever channel it already has.
4. Human opens `url`. The relay serves a small shell page that loads the agent's HTML in a **sandboxed iframe** (locked-down CSP), plus a tiny bridge shim exposing `pane.emit(type, data)` / `pane.submit(data)`.
5. Human interacts → each `emit`/`submit` is POSTed to `/sessions/{id}/events` → appended to that session's event log.
6. Agent retrieves: poll `GET /sessions/{id}/events?since=<cursor>`, or webhook, or SSE. The agent's "ask the human" call blocks until the submit event or a timeout.
7. Session expires after `ttl`.

## Distribution

The repo is an npm-workspaces monorepo with three packages:

- **`@pane/core`** — the relay client: a pure, framework-free HTTP + WebSocket library (`PaneClient` + `openStream`). Build any client on it.
- **`@pane/relay`** — the relay server. Ships as a single Docker container, SQLite by default: `docker build -f packages/relay/Dockerfile -t pane .` then `docker run` and it works.
- **`pane-cli`** — the `pane` command-line tool. `npm i -g pane-cli` gives you `pane create` / `pane state` / `pane send` / `pane watch`.

The `pane` CLI is the agent's entry point. It emits JSON on stdout, so it's harness-agnostic — it works for an MCP host, a cron agent, a shell pipeline, a CI job, or a process-monitoring tool, with nothing to install but one binary. `pane watch <id> --type <event>` streams a session as JSON-lines and exits when the awaited event lands; pipe it into whatever supervises your agent. A LangChain tool wrapper may come later (v2).

```sh
# create a session, hand the URL to a human, wait for the answer
pane create --artifact ./form.html --schema ./schema.json --ttl 600
pane watch ses_xxxx --type form.submitted   # one JSON line per event; exits on the submit
```

Config is `PANE_URL` + `PANE_API_KEY` (env), overridable with `--url` / `--api-key`. Run `pane --help` or `pane <command> --help` for details.

## Stack

TypeScript. Runtime: Node 20+ (Bun fine too). Web: Hono (tiny, fast, container/edge-friendly). ORM: Prisma. SQLite for self-host (default), PostgreSQL for the hosted build. npm workspaces for the monorepo. See `docs/SPEC.md`.

## Configuration

The relay is configured entirely through environment variables (see
[`packages/relay/.env.example`](packages/relay/.env.example) for a copy-paste
starting point):

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `file:./data/pane.db` | SQLite path (self-host) or a `postgresql://` URL (hosted build). |
| `PORT` | `3000` | HTTP listen port. |
| `PUBLIC_URL` | — | Base URL the relay is reachable at. Set it in any real deployment. |
| `API_KEY` | — | Optional. Bootstraps a default agent with this key on boot. If unset and no agents exist, one is auto-minted and printed once. |
| `PANE_SECRET_KEY` | auto-generated | Encryption master key (see below). |
| `REGISTER_RATE_LIMIT` | `5` | Per-IP rate limit for the open `POST /v1/register` endpoint. `0` disables the limiter. |
| `REGISTER_RATE_WINDOW_SECONDS` | `3600` | Window for the registration rate limit. |
| `MAX_ARTIFACT_BYTES` | `2000000` | Largest artifact a session may carry. |
| `MAX_EVENT_DATA_BYTES` | `65536` | Largest `data` payload per event. |
| `MAX_PARTICIPANTS_PER_SESSION` | `32` | Participant cap per session. |
| `DEFAULT_TTL_SECONDS` / `MAX_TTL_SECONDS` | `3600` / `86400` | Default and maximum session lifetime. |
| `TTL_SWEEP_SECONDS` | `60` | Expired-session sweep interval. `0` disables the in-process sweeper. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `METRICS_ENABLED` | `true` | Enables OpenTelemetry metrics. `false` makes the instruments no-ops and unmounts `GET /metrics`. |
| `METRICS_EXPORTER` | `prometheus` | `prometheus` (exposes `GET /metrics`) or `none` (no collection). |

### Metrics (`GET /metrics`)

The relay is instrumented with the vendor-neutral [OpenTelemetry](https://opentelemetry.io/)
metrics SDK. With `METRICS_ENABLED=true` and `METRICS_EXPORTER=prometheus`
(both defaults), `GET /metrics` serves the current metrics in the Prometheus
text exposition format on the relay's normal port — point a Prometheus scrape
at it. Exposed instruments include `pane_sessions_created_total`,
`pane_events_written_total`, `pane_registrations_total`, `pane_errors_total`,
`pane_ws_connections_active`, `pane_sessions_open`, and
`pane_http_request_duration_seconds`.

`/metrics` is unauthenticated, which is the norm for a Prometheus scrape
target — if the relay is publicly reachable, **firewall the endpoint** (or
restrict it at a reverse proxy) so only your monitoring stack can reach it.
Set `METRICS_ENABLED=false` (or `METRICS_EXPORTER=none`) to turn metrics off
entirely; `/metrics` then returns 404.

The hosted/Azure deploy path — pushing metrics to Application Insights via an
OpenTelemetry Azure Monitor exporter — is a planned future addition and is
deliberately not bundled into the open-source core.

### The encryption key (`PANE_SECRET_KEY`)

The relay encrypts secrets at rest (e.g. webhook callback secrets) with a
32-byte master key. Provide it as `PANE_SECRET_KEY` (base64 or hex) — generate
one with `openssl rand -base64 32`.

If `PANE_SECRET_KEY` is unset, the relay generates a key on first boot and
persists it to a `.pane-secret-key` file. **Back that file up and keep it
stable across restarts** — losing it makes previously-encrypted data
unrecoverable. For any real deployment, set `PANE_SECRET_KEY` explicitly rather
than relying on the generated file.

### SSRF protection

Agent-supplied URLs — webhook callback URLs and `html-ref` artifact URLs — are
validated before use. They must be `http`/`https`, must not embed credentials,
and must not resolve to a loopback, private, link-local, or CGNAT address
(this also blocks the cloud metadata endpoint `169.254.169.254`). A URL that
fails these checks is rejected at the API boundary.

### Event delivery ordering

A client connected over the WebSocket may receive an event via the broadcast
stream *before* it receives the `ack` for its own write of that same event.
Clients de-duplicate on the event `id` — treat the `id`, not arrival order, as
the source of truth.

## Business model

Open-core. MIT core (this repo, minus the `/ee/` directory) + a managed hosted version for people who don't want to deploy. The OSS version must do the entire core job standalone, forever, no asterisks; closed = convenience, scale, org/compliance, never core capability. See `docs/SPEC.md` for where the open/closed line sits, `docs/ROADMAP.md` for sequencing.

## Contributing

Issues, fixes, and design feedback are welcome. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, the test suites, and PR
conventions, and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community
expectations. Security vulnerabilities: please report them privately — see
[`SECURITY.md`](SECURITY.md).

## See also

- [`docs/SPEC.md`](docs/SPEC.md): technical design (architecture, API, data model, bridge, auth, open/closed split)
- [`docs/ROADMAP.md`](docs/ROADMAP.md): v1 scope, later phases, strategy notes
- [`docs/architecture/`](docs/architecture/): per-phase implementation docs (Prisma models, endpoints, the bridge shim, the CLI)
- Prior art / landscape: MCP Apps (`blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/`), mcp-ui (`github.com/MCP-UI-Org/mcp-ui`), AG-UI (`copilotkit.ai`), A2UI (Google), Thesys C1
- Motivating read: Thariq, "Using Claude Code: The Unreasonable Effectiveness of HTML" (`simonwillison.net/2026/May/8/unreasonable-effectiveness-of-html/`)
