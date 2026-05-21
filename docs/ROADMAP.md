# Pane: Roadmap

Companion to the root `README.md` and `SPEC.md` (sibling). Sequencing matters more than scope: ship the boring shippable thing, let it pull you toward the exciting thing.

## v1: the minimum that's actually useful (OSS only)

Goal: an agent can hand a human a UI by URL and get a structured answer back. Nothing more.

- [ ] Relay HTTP API: `POST /v1/register`, `POST /v1/sessions` (artifact + schema + participants), `GET /v1/sessions/{id}`, `PATCH /v1/sessions/{id}/{schema,artifact}`, `DELETE /v1/sessions/{id}`, `POST /v1/sessions/{id}/events`, `GET /v1/sessions/{id}/events?since=<opaque cursor>&wait=`. One Docker container, SQLite by default.
- [ ] WebSocket transport: `WS /v1/sessions/{id}/stream`. Bidirectional event stream with token auth, replay-on-connect, broadcast to all participants.
- [ ] Four-table Prisma schema (`agents`, `sessions`, `participants`, `events`) per `SPEC.md`. `prisma migrate`, TTL cleanup job. `events.id` is an autoincrement `Int` today; the `?since=` cursor is opaque in the API. (Widening `events.id` to BigInt is tracked as future work.)
- [ ] Schema validation: every write checks `type` exists in `session.event_schema`, `data` validates against the type's payload (Ajv), and `author.kind ∈ emittedBy`. Idempotency-key dedup on `(session_id, author_id, key)`.
- [ ] Identity stamping: relay stamps `author` server-side from the auth token; clients cannot spoof. `causation_id` stored verbatim as metadata.
- [ ] Sandboxed iframe shell + bridge shim: `sandbox="allow-scripts"` (no `allow-same-origin`), CSP `connect-src 'none'` on `/s/{token}/content`. `pane.emit / pane.on / pane.state` shim, `postMessage` origin check on the shell-iframe boundary.
- [ ] DB-backed bearer-token auth for agent → relay: keys in `agents` (`sha256` + display prefix + `revoked_at`). `POST /register` gated by `REGISTRATION_MODE` (closed default / secret / open), bounded by a per-IP rate limiter in the secret and open modes. Per-identity participant tokens issued at session create.
- [ ] Security caps: 2 MB artifact, 64 KB event data, per-agent session-create rate limit. Best-effort webhook delivery with HMAC signing (durable retry deferred to hosted).
- [ ] The `pane` CLI (`@paneui/cli`): `pane session create` returns the human URL(s); `pane session watch <id> --type <event>` streams the session as JSON-lines and exits when that event lands; `pane session show` / `pane session send` cover non-blocking reads and agent emits. Harness-agnostic — works for MCP hosts, cron agents, shell pipelines, CI, Claude Code's process tools.
- [ ] Dogfood demo: a `claudeclaw` integration where an agent asks Lalit something through a real UI.
- [ ] README + a 30-second demo clip. MIT license. Publish the repo.
- [ ] A hosted-lite demo instance: the OSS container, run on Azure credits, per-user provisional keys, generous limits, no SLA, "may change/disappear", so people can try it without deploying.

**Explicitly NOT in v1:** durable / dead-lettered webhook delivery, SSE (long-poll + WS cover the cases), participant access control (URL token IS the auth), multi-agent sessions, multi-file artifact bundles (React/Vue with real bundling), the proper hosted product (orgs/dashboard/billing/SLA), analytics console, UI templates, the LangChain tool, CRDT real-time co-editing, a component DSL.

## v2: only if v1 gets a pulse

- The proper hosted product: real accounts (with the "claim with email" upgrade flow), API key management, a console (browse sessions, replay interaction timelines, analytics: open rate / completion rate / time-to-answer, search), orgs/projects, usage quotas, billing.
- Durable webhook delivery (dead-letter queue, replay, configurable retry; HMAC signing already in v1). SSE as a first-class retrieval mode.
- Optional auth on session links (magic-link / "only user X can open this").
- The LangChain tool wrapper; whatever other agent-framework integrations have demand.
- MCP-Apps-compat adapter for the bridge (so UIs written for MCP Apps run on Pane unchanged).

## v3+: north star (don't start here)

Shared, live UI where the agent is a participant, not just a form-handler: agent spins up a sketchboard on the fly, both agent and human edit it in real time, agent reacts to the human's edits as they land. This is request/response → real-time sync: CRDT/OT shared state, websockets, presence, conflict resolution, undo across two editors (Liveblocks/Yjs/PartyKit/Convex territory). The agent side gets harder too: perceive canvas state, decide edits, emit them, react (closer to "computer use" agents). Same platform risk, bigger incumbent (tldraw/Figma/Excalidraw adding agents). If chasing it: narrow to one killer surface ("the whiteboard where Claude draws with you"), not "a SaaS for any agent UI".

## Strategy notes (read before sinking time in)

- **This is the reputation / ecosystem lever, not the money lever.** Near-term income = consulting (warm network, ~€120-150/hr, 15-20 hrs/week, first client target ~4 weeks). Independent of this, and this exploration *feeds* it (it's what makes the "I get agentic systems into production" pitch credible). Product-revenue lever = the AgentHub PR reviewer (already built the hard part, known buyer = EU dev teams, clear ROI). Don't let Pane eat the outreach time.
- **OSS first, hosted second.** A hosted relay with no users is a server quietly spending money. Build OSS v1 + the hosted-lite demo; the proper hosted product is v2, gated on real usage.
- **Watch the moat.** MCP Apps is the official, Anthropic-backed standard. "Render an MCP App via a hosted URL outside a host app" is a natural next version; if Anthropic/OpenAI ship "publish an Artifact as a public link with a callback," Pane's differentiation shrinks to hosting + UX. Build on MCP Apps' bridge contract, don't compete with it. Be deliberate about what's defensible.
- **The closed-free relay is the one option to actively avoid.** Gives up the OSS-trust adoption mechanism, the open-protocol standard-play upside, and the reputation asset, just to keep code private and skip self-host docs, *and* defers revenue. For dev infra, closed-source kills distribution. Pick OSS-core relay, or pick not-the-relay.
- **The bar to clear is "send a Telegram doc + ask a text question."** That's free and good enough for most asks. Pane only wins on the genuinely-too-rich-for-text slice. Keep it small; the moment publishing a UI is heavier than the alternative, it loses.
- **Don't decide the name/domain yet.** "Pane" is a working title; the bare-word domain is taken across .com/.dev/.io (only obscure TLDs like `pane.tools` are free, and `.tools` jumps from €13 to €34/yr). When v1 ships and it's worth pursuing, spend ~€12/yr on a flat-renewing `.com` or `.dev`: a coined word or two-word compound. 5-minute task, do it when there's something to attach it to.

## Decided

- **Language: TypeScript.** Node 20+ (Bun fine), Hono for the web layer, **Prisma** ORM (SQLite for self-host/default, PostgreSQL for the hosted build). See `SPEC.md`.
- **Monorepo: npm workspaces.** Three packages — `@paneui/core` (pure relay client: HTTP + WS), `@paneui/relay` (the server), `@paneui/cli` (the published `pane` CLI).
- **Client wrapper: a CLI, not an MCP server.** The originally-planned MCP server was dropped in favour of `@paneui/cli`: a CLI that emits JSON on stdout is harness-agnostic (MCP host, cron agent, shell, CI, Claude Code process tools) and drops the `@modelcontextprotocol/sdk` dependency. The relay API contract lives in `@paneui/core`. An MCP wrapper remains a possible v2 addition. See `docs/architecture/phase-4-mcp-ttl-deploy.md`.

## Open questions

- ~~Bridge contract.~~ DECIDED in `SPEC.md` v1: thin `pane.emit / pane.on / pane.state` shim. An MCP-Apps-compat adapter is a v2 candidate.
- Name. ("Pane" is a placeholder; see strategy note above.)
- Is request/response genuinely enough for adoption, or does it need the collaborative-canvas hook to be interesting? (Bet: enough; ship and find out cheaply.)
- Eventual hosted pricing shape: per-session volume, seats, or both?
