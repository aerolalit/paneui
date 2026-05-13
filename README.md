# Pane

_Working title (not final. The bare-word domain is taken across .com/.dev/.io; revisit before launch). Earlier name in notes: "Agent Relay"._

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

Ships as: a standalone HTTP API + an MCP server (`create_pane_session` / `await_pane_result` tools, zero-friction for MCP agents) + (later) a LangChain tool. Single Docker container, SQLite by default: `docker run` and it works.

## Stack

TypeScript. Runtime: Node 20+ (Bun fine too). Web: Hono (tiny, fast, container/edge-friendly). ORM: Prisma. SQLite for self-host (default), PostgreSQL for the hosted build. MCP server via the official `@modelcontextprotocol/sdk`. See `docs/SPEC.md`.

## Business model

Open-core. MIT core (this repo, minus the `/ee/` directory) + a managed hosted version for people who don't want to deploy. The OSS version must do the entire core job standalone, forever, no asterisks; closed = convenience, scale, org/compliance, never core capability. See `docs/SPEC.md` for where the open/closed line sits, `docs/ROADMAP.md` for sequencing.

## See also

- [`docs/SPEC.md`](docs/SPEC.md): technical design (architecture, API, data model, bridge, auth, open/closed split)
- [`docs/ROADMAP.md`](docs/ROADMAP.md): v1 scope, later phases, strategy notes
- [`docs/architecture/`](docs/architecture/): per-phase implementation docs (Prisma models, endpoints, the bridge shim, the MCP tools)
- Prior art / landscape: MCP Apps (`blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/`), mcp-ui (`github.com/MCP-UI-Org/mcp-ui`), AG-UI (`copilotkit.ai`), A2UI (Google), Thesys C1
- Motivating read: Thariq, "Using Claude Code: The Unreasonable Effectiveness of HTML" (`simonwillison.net/2026/May/8/unreasonable-effectiveness-of-html/`)
