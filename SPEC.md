# Pane — Technical Spec

Design sketch, v0. Subject to change. Companion to `README.md` and `ROADMAP.md`.

## Stack (decided)

TypeScript. Runtime: Node 20+ (Bun is fine — keep code runtime-agnostic). Web framework: Hono (tiny, fast, runs on Node/Bun/edge — good fit for a single small container). ORM: **Prisma** — SQLite for the self-host/default build, PostgreSQL for the hosted build. MCP server via the official `@modelcontextprotocol/sdk`. Keep dependencies few.

Note on Prisma + two databases: Prisma sets the DB via the `provider` in `schema.prisma`, not purely the connection string, so switching SQLite↔Postgres isn't a runtime swap — handle it at build time (a small codegen step, or two `schema.prisma` targets, or env-templated provider). For v1 (SQLite only) this doesn't matter; bake the Postgres path in when the hosted build appears. The model definitions stay in one place either way.

## Roles

- **Agent** — anything that wants to ask a human something richer than a text prompt. Has no public address; only makes outbound HTTPS calls.
- **Relay** — the Pane service. Has a public URL. Stores sessions + events, serves the UI, exposes the API. Self-hosted (one Docker container) or the managed hosted version.
- **Human** — opens a URL in any browser, interacts with the UI.

## The flow

```
agent ──POST /sessions {html, schema, ttl}──▶ relay ──▶ {session_id, url}
agent ──(sends url over its own channel: Telegram/Slack/email)──▶ human
human ──GET /s/{id}──▶ relay ──▶ shell page + sandboxed iframe(/s/{id}/content) + bridge shim
human ──(interacts)──▶ bridge ──postMessage──▶ shell ──POST /s/{id}/events──▶ relay (append to log)
agent ──GET /s/{id}/events?since=N (or webhook, or SSE)──▶ relay ──▶ new events
                                                                  └─ on "submit": status=submitted, result set
agent's "ask the human" call returns (submit event, or timeout)
```

## HTTP API (v1)

All agent-facing endpoints require `Authorization: Bearer <api_key>`.

- `POST /register` → `{api_key}` — agent self-provisions. (Hosted: rate-limited, returns a *provisional/limited* key; optional later "claim with email" lifts limits. Self-host: off by default, or behind a config `REGISTRATION_SECRET`.)
- `POST /sessions` `{html, schema?, ttl?, metadata?}` → `{session_id, url}` — `html` is capped (~2 MB). `schema` (optional JSON) describes the data the agent expects back. `ttl` defaults to e.g. 1h.
- `GET /sessions/{id}` → session metadata + `status` + `result` (no html)
- `GET /sessions/{id}/events?since=<id>` → events with `id > since`, ordered. Long-poll variant: `?wait=30` holds the connection up to N seconds for the next event. SSE variant: `GET /sessions/{id}/events/stream`.
- `DELETE /sessions/{id}` — end early
- `GET /keys` / `DELETE /keys/{id}` — list/revoke keys for the calling account

Human-facing (no auth — the URL token *is* the auth):
- `GET /s/{token}` — the shell page (creates the sandboxed iframe, injects the bridge shim)
- `GET /s/{token}/content` — streams the stored HTML with `Content-Security-Policy`, `X-Frame-Options`, sandbox-appropriate headers. Served only through this endpoint so the relay controls the headers; never a raw/public CDN URL.
- `POST /s/{token}/events` `{type, payload}` — called by the bridge shim

Webhook (optional): `POST /sessions` can take `webhook_url`; the relay POSTs `{session_id, event}` there on each new event (or just on `submit`). v1: best-effort with a couple of retries. (Robust delivery — signing, dead-letter — is a hosted feature.)

## The bridge

The agent's HTML runs inside a sandboxed `<iframe>` (`sandbox="allow-scripts allow-forms"`, no `allow-same-origin` — so it can't touch the parent or the relay's cookies). Its only channel out is `window.postMessage` to the parent shell page. The shell relays validated messages to `POST /s/{token}/events`.

The shim injected/available to the agent's HTML:
- `pane.emit(type, data)` — fire an arbitrary event (e.g. `"open"`, `"button_click"`, `"step_done"`)
- `pane.submit(data)` — the terminal answer; sets session `status=submitted`, `result=data`, and is the event the agent's blocking call waits for
- `pane.on(type, handler)` — receive events the agent pushes *into* the UI (future: agent updating the UI mid-session)

Decision pending: adopt the **MCP Apps** postMessage/JSON-RPC contract (`ui/initialize`, `ui/toolResult`, `tools/call`) verbatim — so any UI written for an MCP App works on Pane unchanged and MCP-aware agents target it with zero changes — versus a thinner custom `pane.*` shim with an MCP-Apps-compat mode. Leaning toward: thin `pane.*` for the simple case + an MCP-Apps adapter. The protocol/SDK stays fully open (it's a standard play, not a moat).

## Data model (v1, two tables)

`sessions`:
| column | notes |
|---|---|
| `id` | URL token, 128+ bits of entropy — this is the access control for an anonymous link |
| `owner` (or `key_id`) | which API key created it; v1 only ever writes one value, but having the column makes multi-tenant-later a migration not a refactor |
| `html` | TEXT, capped ~2 MB |
| `schema` | JSON, optional |
| `status` | `open` / `submitted` / `expired` |
| `created_at`, `expires_at` | |
| `metadata` | JSON, arbitrary (label, channel it was sent on, ...) |
| `result` | JSON, denormalized copy of the final `submit` payload (convenience; source of truth is the event log) |
| `webhook_url` | nullable |

`events`:
| column | notes |
|---|---|
| `id` | integer autoincrement — doubles as the global poll cursor |
| `session_id` | FK → `sessions.id`, `ON DELETE CASCADE` |
| `type` | text, open-ended (`open`, `emit`, `submit`, `heartbeat`, ...) |
| `payload` | JSON |
| `created_at` | |
| index | `(session_id, id)` so `?since=N` is `WHERE session_id=? AND id>? ORDER BY id` |

(Hosted-only, later, in `/ee/`: `accounts`/`api_keys`, `projects`/`orgs`, RBAC tables, audit log.)

TTL cleanup: periodic `DELETE FROM sessions WHERE expires_at < now()`; cascade removes events.

### Storage / DB

- HTML is stored in the DB (TEXT column on the session row), not the filesystem or object storage. One storage system, free TTL cleanup, identical self-hosted/hosted. (Object storage is a hosted-only optimization for later, behind config.)
- DB selection: SQLite (`DATABASE_URL=file:./data.db`) for self-host/default; PostgreSQL (`DATABASE_URL=postgresql://...`) for the hosted build. With Prisma the dialect is the `provider` in `schema.prisma`, set at build time (see Stack note) — not a runtime swap. Model definitions live in one schema. No hand-rolled "Store interface with two impls" abstraction in v1 — Prisma is the data layer.
- SQLite is the right default for self-host: zero ops, single writer (the relay), tiny append-mostly workload, ephemeral data. Never make Postgres mandatory in the OSS version.

## Auth (three layers; only #1 in v1)

1. **Agent → relay**: one bearer token. "My sessions" = sessions created with this key. Self-host: one key set at deploy (`API_KEY` env var) + optionally an admin endpoint to mint more. v1.
2. **Human → session link**: the URL token is the auth — unguessable, whoever has the link opens it. "Only user X can open this" = a later/hosted feature.
3. **Multi-tenancy / roles / orgs / RBAC / audit / SSO**: the hosted product. `/ee/`, v2+.

## Security notes (the part you can't get wrong)

- Sandboxed iframe with **no** `allow-same-origin`. The agent's JS can never read the relay's cookies, the parent's DOM, or call relay endpoints directly — only `postMessage` to the parent, which validates and forwards.
- Strict `Content-Security-Policy` on `/s/{token}/content` (no `unsafe-eval`; restrict `connect-src`, `img-src`, etc. — the agent's HTML should be self-contained, no external CDNs encouraged).
- `X-Frame-Options` / `frame-ancestors` so the relay's own pages can't be reframed.
- The HTML is served only through the relay's endpoint (never a raw public URL) so the relay owns the headers.
- `POST /register` on the hosted version is rate-limited (per IP) and returns provisional/limited keys — never an open unlimited-key faucet on a public domain (abuse: spam sessions, phishing pages on `relay.<domain>`, burned compute).
- Keys revocable from day 1 (`revoked` flag).
- HTML size cap; event payload size cap; per-key rate limits on session creation.

## Open/closed line (open-core)

Principle: **the OSS version must do the entire core job, end to end, for one user, on their own server, forever, with no asterisks.** Never cap volume in the self-hosted version. Never make OSS phone home or need an account. Open the bridge protocol fully.

- **Open source (core relay):** publish a session; serve the UI (sandboxed iframe, bridge shim, CSP); capture interactions (event log); retrieve (poll, long-poll, SSE, basic webhook with retries); lifecycle (TTL, one-time links, bearer-token auth, agent self-register-with-secret for self-host); the MCP server + LangChain tool wrappers; single-container deploy + docs.
- **Closed / hosted-only (`/ee/` + private):** managed hosting itself; a console (browse sessions, replay interaction timelines, analytics — open rate, completion rate, time-to-answer — search); orgs/multi-tenancy (projects, multiple scoped API keys, usage quotas); team + access control (human SSO/magic-link login to gate who can open a session, audit logs, retention policies, RBAC); higher limits, SLA, SOC2, EU data residency, support; maybe a managed UI-template gallery (templates themselves OSS; gallery + analytics hosted); robust webhook delivery (signing, dead-letter).

**Code-sharing:** one repo, mostly MIT/Apache, an `/ee/` directory under a commercial license (GitLab/PostHog pattern). Community edition = default build with `/ee/` excluded; hosted edition = core + `/ee/`. License-key gate only on enterprise features that run in self-host. Design the core with clean seams (auth, storage, event delivery as interfaces) so `/ee/` plugs in instead of monkey-patching — but don't build a full plugin framework. Move to "OSS core as a published library + separate private repo" only if proprietary code grows or others want to depend on the core.

**License:** MIT or Apache on the core; hosted-only code in a separate private repo. Skip BSL / "fair-code".
