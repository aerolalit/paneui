# Pane — Roadmap

Companion to `README.md` and `SPEC.md`. Sequencing matters more than scope: ship the boring shippable thing, let it pull you toward the exciting thing.

## v1 — the minimum that's actually useful (OSS only)

Goal: an agent can hand a human a UI by URL and get a structured answer back. Nothing more.

- [ ] The relay: `POST /sessions` (html, ttl) → `{id, url}`; serve HTML in a sandboxed iframe + the bridge shim (`pane.emit` / `pane.submit`); `POST /sessions/{id}/events`; `GET /sessions/{id}/events?since=N`. SQLite. One Docker container.
- [ ] Two-table schema (`sessions`, `events`) per `SPEC.md`, as a Prisma schema on SQLite; `prisma migrate`; TTL cleanup job.
- [ ] Bearer-token auth for agent → relay (one key via `API_KEY` env var). `POST /register` behind `REGISTRATION_SECRET`, off by default.
- [ ] Hard security basics: sandboxed iframe (no `allow-same-origin`), strict CSP on `/content`, HTML/payload size caps, key revocation.
- [ ] One client wrapper: an MCP server exposing `ask_human_with_ui(html, schema)` → blocks on the submit event. (Most likely first users are the Claude/MCP crowd.)
- [ ] One demo: wire it into a `claudeclaw` instance so an agent can genuinely ask Lalit something through a UI. Dogfood before anyone else touches it.
- [ ] README + a 30-second demo clip. MIT license. Publish the repo.
- [ ] A hosted-lite demo instance: the OSS container, run on Azure credits, per-user provisional keys, generous limits, no SLA, "may change/disappear" — so people can try it without deploying.

**Explicitly NOT in v1:** webhooks (beyond maybe a trivial best-effort one), SSE, auth on links, the proper hosted product (accounts/dashboard/billing/SLA/teams/roles), analytics, UI templates, the LangChain tool, real-time collaborative / multiplayer canvas, a component DSL.

## v2 — only if v1 gets a pulse

- The proper hosted product: real accounts (with the "claim with email" upgrade flow), API key management, a console (browse sessions, replay interaction timelines, analytics: open rate / completion rate / time-to-answer, search), orgs/projects, usage quotas, billing.
- Robust webhook delivery (signing, retries, dead-letter), SSE as a first-class retrieval mode.
- Optional auth on session links (magic-link / "only user X can open this").
- The LangChain tool wrapper; whatever other agent-framework integrations have demand.
- MCP-Apps-compat adapter for the bridge (so UIs written for MCP Apps run on Pane unchanged).

## v3+ — north star (don't start here)

Shared, live UI where the agent is a participant, not just a form-handler: agent spins up a sketchboard on the fly, both agent and human edit it in real time, agent reacts to the human's edits as they land. This is request/response → real-time sync: CRDT/OT shared state, websockets, presence, conflict resolution, undo across two editors (Liveblocks/Yjs/PartyKit/Convex territory). The agent side gets harder too — perceive canvas state, decide edits, emit them, react (closer to "computer use" agents). Same platform risk, bigger incumbent (tldraw/Figma/Excalidraw adding agents). If chasing it: narrow to one killer surface ("the whiteboard where Claude draws with you"), not "a SaaS for any agent UI".

## Strategy notes (read before sinking time in)

- **This is the reputation / ecosystem lever, not the money lever.** Near-term income = consulting (warm network, ~€120-150/hr, 15-20 hrs/week, first client target ~4 weeks) — independent of this, and this exploration *feeds* it (it's what makes the "I get agentic systems into production" pitch credible). Product-revenue lever = the AgentHub PR reviewer (already built the hard part, known buyer = EU dev teams, clear ROI). Don't let Pane eat the outreach time.
- **OSS first, hosted second.** A hosted relay with no users is a server quietly spending money. Build OSS v1 + the hosted-lite demo; the proper hosted product is v2, gated on real usage.
- **Watch the moat.** MCP Apps is the official, Anthropic-backed standard. "Render an MCP App via a hosted URL outside a host app" is a natural next version; if Anthropic/OpenAI ship "publish an Artifact as a public link with a callback," Pane's differentiation shrinks to hosting + UX. Build on MCP Apps' bridge contract, don't compete with it. Be deliberate about what's defensible.
- **The closed-free relay is the one option to actively avoid** — gives up the OSS-trust adoption mechanism, the open-protocol standard-play upside, and the reputation asset, just to keep code private and skip self-host docs, *and* defers revenue. For dev infra, closed-source kills distribution. Pick OSS-core relay, or pick not-the-relay.
- **The bar to clear is "send a Telegram doc + ask a text question."** That's free and good enough for most asks. Pane only wins on the genuinely-too-rich-for-text slice. Keep it small; the moment publishing a UI is heavier than the alternative, it loses.
- **Don't decide the name/domain yet.** "Pane" is a working title; the bare-word domain is taken across .com/.dev/.io (only obscure TLDs like `pane.tools` are free, and `.tools` jumps from €13 to €34/yr). When v1 ships and it's worth pursuing, spend ~€12/yr on a flat-renewing `.com` or `.dev` — coined word or two-word compound. 5-minute task, do it when there's something to attach it to.

## Decided

- **Language: TypeScript.** Node 20+ (Bun fine), Hono for the web layer, **Prisma** ORM (SQLite for self-host/default, PostgreSQL for the hosted build), `@modelcontextprotocol/sdk` for the MCP server. See `SPEC.md`.

## Open questions

- Bridge: adopt MCP Apps' postMessage/JSON-RPC contract verbatim, or thin `pane.*` shim + an MCP-Apps adapter? (Leaning latter.)
- Name. ("Pane" is a placeholder — see strategy note above.)
- Is request/response genuinely enough for adoption, or does it need the collaborative-canvas hook to be interesting? (Bet: enough — ship and find out cheaply.)
- Eventual hosted pricing shape: per-session volume, seats, or both?
