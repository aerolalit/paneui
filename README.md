# Pane

**Apps are built for everyone. Panes are built for you.** Your agent builds a pane (the exact form, dashboard, or tool you need) and Pane hosts it by URL, no GUI host app needed on either side. You use it; your agent reads, queries, and acts on the data it produces (WS, poll, or webhook). Pane doesn't build apps. It hosts the panes your agent builds for you.

## The problem

Agents can already emit rich output (the "ask Claude for HTML, not Markdown" pattern). But the human's reply is still prose. The agent → human channel is rich, the human → agent channel is a text box. Pane closes the loop: agent renders a UI (form, picker, doc-review view, dashboard, sketchboard), human manipulates it, every interaction emits structured data, the agent retrieves it (or pushes its own updates back into the same UI). The human "answers" by using a UI, not by typing.

This matters most for agents that live **outside a GUI host app**: cron agents, Slack/Telegram bots, CI agents, headless servers, personal-agent setups. None of them can use MCP Apps (which needs a host app to render the UI). Pane needs neither a host app nor a public address on the agent's side; the agent only makes outbound calls to the relay.

## How it works

1. Agent generates an HTML page (the UI it wants the human to act on).
2. Agent → `POST /sessions` with `{html, schema, ttl}` → gets `{session_id, url}`.
3. Agent sends `url` to the human over whatever channel it already has.
4. Human opens `url`. The relay serves a small shell page that loads the agent's HTML in a **sandboxed iframe** (locked-down CSP), plus a tiny pane runtime exposing `pane.emit(type, data)` / `pane.submit(data)`.
5. Human interacts → each `emit`/`submit` is POSTed to `/sessions/{id}/events` → appended to that session's event log.
6. Agent retrieves: poll `GET /sessions/{id}/events?since=<cursor>`, or webhook, or SSE. The agent's "ask the human" call blocks until the submit event or a timeout.
7. Session expires after `ttl`.

> **Event ordering.** A client connected over the WebSocket may receive an
> event via the broadcast stream *before* the `ack` for its own write of that
> same event. Clients de-duplicate on the event `id` — treat the `id`, not
> arrival order, as the source of truth.

## Install

No build step, no host app. Pick your audience — paste the agent block into your AI agent's chat, or run the human block yourself.

### Paste to your AI agent

Paste the block below into your AI agent's chat. It will install the CLI, register against the hosted relay, and install the Pane skill into its own skill directory.

````text
Install Pane for me. Pane lets you (the agent) build me (the human) a pane: a rich interactive UI hosted by URL, built for the moment I need it. If it captures input, you get my response back as structured data. Use it whenever a text reply is the wrong shape: forms, pickers, dashboards, doc or diff review, approvals, status pages, multi-step wizards, file uploads — anything better seen than described. Input is optional; a read-only dashboard or status view is a valid Pane.

Install everything at GLOBAL / USER scope, not in the current workspace. Pane is a personal capability I want available in every project, not a per-repo dependency. Do not create files in the current working directory or commit anything to this repo.

Do the following:
1. Install the CLI globally: `npm i -g @paneui/cli` (needs Node 20+). The binary is `pane`. Do not add it to the current project's package.json.
2. Install the Pane skill into your agent's GLOBAL / USER skill directory, not a project-local one. For example:
   - Claude Code: ~/.claude/skills/pane/SKILL.md  (NOT .claude/skills/ in the current repo)
   - Cursor: user-level rules, NOT .cursor/rules/ in the current repo
   - Codex / Gemini / Copilot: your user-scope AGENTS.md / GEMINI.md / instructions file, NOT the project root
   Run `pane skill show` to fetch the skill from the relay you're targeting — it prints the raw markdown to stdout, version-matched to that relay. Capture that output and save it in the appropriate format for your runtime (Claude Code keeps the markdown as-is; Cursor wants `.mdc` rules; Codex / Gemini compose it into the user-scope AGENTS.md / GEMINI.md).
3. Register against the hosted relay: `pane agent register --name "<short-descriptive-agent-name>"`. Pick a name that identifies your agent (e.g. `claude-code-lalit-macbook`, `cursor-work-laptop`) — the default is unhelpful. One-time, writes a key to ~/.config/pane/config.json (already user-scope).
4. Confirm install with `pane key list`. This round-trips your key against the relay and prints { agent_id, name, key_prefix, ... } — proves the CLI is installed AND registration succeeded.
5. Now exercise the round-trip end-to-end so I can see it work:
   - Create a simple two-way pane — a small HTML artifact with a text input and a submit button that posts an event back to you (use whatever shape `pane session create` and the SKILL.md describe; the simplest "hello" form is fine).
   - Print the resulting pane URL and ask me to open it.
   - Start watching for the submit event (e.g. `pane session watch <session-id>`).
   - When I submit, show me the structured event payload you received. That's the "aha" moment — confirms the full round-trip works.

After this, reach for `pane session create / show / send / watch` whenever a UI would communicate better than text. Run `pane <noun> <verb> --help` for authoritative options.
````

### Run yourself (human)

Five commands. Needs Node 20+. The skill-install step auto-detects your agent (Claude Code, Cursor, Codex, Gemini, Copilot, Windsurf, Continue, …) and installs in the right place.

```sh
# 1. Install the CLI (Node 20+)
npm i -g @paneui/cli

# 2. Register with the hosted relay — pick a short, descriptive agent name
pane agent register --name "<short-descriptive-agent-name>"

# 3. Confirm — round-trips your key against the relay
pane key list

# 4. Install the skill into your agent (auto-detects Claude Code,
#    Cursor, Codex, Gemini, Copilot, Windsurf, Continue, …)
npx skills add aerolalit/paneui

# 5. Try it — create a tiny round-trip pane, then watch for the event.
#    Open the urls.humans link it prints, type something, hit submit.
pane session create --artifact '<form onsubmit="event.preventDefault();pane.send({type:\"hello\",payload:{msg:this.m.value}})"><input name=m><button>send</button></form>' --event-schema '{"events":{"hello":{"emittedBy":["page"],"payload":{"type":"object","properties":{"msg":{"type":"string"}},"required":["msg"]}}}}'

pane session watch <session-id> --type hello
```

## Distribution

The repo is an npm-workspaces monorepo with three packages:

- **`@paneui/core`** — the relay client: a pure, framework-free HTTP + WebSocket library (`PaneClient` + `openStream`). Build any client on it.
- **`@paneui/relay`** — the relay server. Use the hosted instance, or self-host it as a single Docker container (SQLite by default) — see [Self-hosting](#self-hosting).
- **`@paneui/cli`** — the `pane` command-line tool. The agent's entry point: emits JSON on stdout, so it's harness-agnostic — works for an MCP host, a cron agent, a shell pipeline, a CI job, or a process supervisor. `pane session watch <id> --type <event>` streams a session as JSON-lines and exits when the awaited event lands. A LangChain tool wrapper may come later (v2).

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
- [`docs/architecture/`](docs/architecture/): per-phase implementation docs (Prisma models, endpoints, the pane runtime, the CLI)
- Prior art / landscape: MCP Apps (`blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/`), mcp-ui (`github.com/MCP-UI-Org/mcp-ui`), AG-UI (`copilotkit.ai`), A2UI (Google), Thesys C1
- Motivating read: Thariq, "Using Claude Code: The Unreasonable Effectiveness of HTML" (`simonwillison.net/2026/May/8/unreasonable-effectiveness-of-html/`)
