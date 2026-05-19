# Pane

**A round-trip UI channel between agents and humans.** An agent hands a human a rich interactive UI by URL (no GUI host app needed on either side), captures the human's interactions as structured data, and feeds that data back to the agent (WS, poll, or webhook).

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

> **Event ordering.** A client connected over the WebSocket may receive an
> event via the broadcast stream *before* the `ack` for its own write of that
> same event. Clients de-duplicate on the event `id` — treat the `id`, not
> arrival order, as the source of truth.

## Distribution

The repo is an npm-workspaces monorepo with three packages:

- **`@pane/core`** — the relay client: a pure, framework-free HTTP + WebSocket library (`PaneClient` + `openStream`). Build any client on it.
- **`@pane/relay`** — the relay server. Use the hosted instance, or self-host it as a single Docker container (SQLite by default) — see [Self-hosting](#self-hosting).
- **`@pane/cli`** — the `pane` command-line tool. `npm i -g @pane/cli` gives you `pane create` / `pane state` / `pane send` / `pane watch`.

The `pane` CLI is the agent's entry point. It emits JSON on stdout, so it's harness-agnostic — it works for an MCP host, a cron agent, a shell pipeline, a CI job, or a process-monitoring tool, with nothing to install but one binary. `pane watch <id> --type <event>` streams a session as JSON-lines and exits when the awaited event lands; pipe it into whatever supervises your agent. A LangChain tool wrapper may come later (v2).

```sh
# create a session, hand the URL to a human, wait for the answer
pane create --artifact ./form.html --event-schema ./schema.json --ttl 600
pane watch ses_xxxx --type form.submitted   # one JSON line per event; exits on the submit
```

The CLI defaults to the hosted relay, so `pane register` alone gets you a key.
Self-hosting? Pass `--url <your-relay>` once (see [Self-hosting](#self-hosting)).
Run `pane --help` or `pane <command> --help` for details.

### Teaching an agent to use pane

An agent needs two things: the `pane` CLI on its `PATH`, and the pane skill
([Agent Skills](https://agentskills.io) format) in its skills directory.

**Claude Code** — install the skill from the plugin marketplace:

```text
/plugin marketplace add aerolalit/pane
/plugin install pane@pane
```

**Other agents** (Codex, Cursor, Copilot, Gemini CLI, …) — install the skill
with the cross-agent [`skills`](https://github.com/vercel-labs/skills) tool:

```sh
npx skills add aerolalit/pane --skill pane
```

Then install and register the CLI:

```sh
npm i -g @pane/cli
pane register
```

`pane register` provisions an API key against the hosted relay and saves it to
the CLI config file, so every later command works with no env vars. The skill
file is pure skill content — it documents the `pane` workflow and assumes the
CLI is already installed and registered.

## Stack

TypeScript. Runtime: Node 20+ (Bun fine too). Web: Hono (tiny, fast, container/edge-friendly). ORM: Prisma. SQLite for self-host (default), PostgreSQL for the hosted build. npm workspaces for the monorepo. See `docs/SPEC.md`.

## Self-hosting

You don't have to run a relay — point the CLI at the hosted instance and you're
done. But Pane is open-core (MIT) and self-hosts with no paid dependencies:

- **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)** — run your own relay in one
  container on SQLite. Pull the image, set three env vars, done.
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — the operator guide: Postgres,
  multi-replica scaling, observability, and the Azure Container Apps reference
  deployment.

The relay is configured entirely through environment variables —
[`packages/relay/.env.example`](packages/relay/.env.example) is the full
reference.

## Business model

Open-core. This repo is the MIT core; a managed hosted version (with org/compliance and scale extras) is offered for people who don't want to deploy. The OSS version must do the entire core job standalone, forever, no asterisks; closed = convenience, scale, org/compliance, never core capability. See `docs/SPEC.md` for where the open/closed line sits, `docs/ROADMAP.md` for sequencing.

## Contributing

Issues, fixes, and design feedback are welcome. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, the test suites, and PR
conventions, and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community
expectations. Security vulnerabilities: please report them privately — see
[`SECURITY.md`](SECURITY.md).

## See also

- [`docs/SPEC.md`](docs/SPEC.md): technical design (architecture, API, data model, bridge, auth, open/closed split)
- [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md): run your own relay on SQLite, in one container
- [`docs/DEPLOY.md`](docs/DEPLOY.md): operator deployment — Postgres, scaling, observability, Azure
- [`docs/ROADMAP.md`](docs/ROADMAP.md): v1 scope, later phases, strategy notes
- [`docs/architecture/`](docs/architecture/): per-phase implementation docs (Prisma models, endpoints, the bridge shim, the CLI)
- Prior art / landscape: MCP Apps (`blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/`), mcp-ui (`github.com/MCP-UI-Org/mcp-ui`), AG-UI (`copilotkit.ai`), A2UI (Google), Thesys C1
- Motivating read: Thariq, "Using Claude Code: The Unreasonable Effectiveness of HTML" (`simonwillison.net/2026/May/8/unreasonable-effectiveness-of-html/`)
