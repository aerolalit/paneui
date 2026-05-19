# Pane: Architecture docs

Per-phase architecture for building Pane v1. This sits one level below `docs/SPEC.md` and one level above the code:

- `README.md` (root): what Pane is, for whom.
- `docs/SPEC.md`: the system-level design. Architecture, API surface, data model, bridge, auth, open/closed line. The "what and why" at the whole-system level.
- `docs/ROADMAP.md`: phasing and strategy. What's in v1, what's deferred, why this order.
- **`docs/architecture/` (this dir)**: the "what and why" at the phase/module level, with the exact interfaces (Prisma models, endpoint shapes, the `pane.*` shim, the CLI commands) that the code has to satisfy. Detailed enough to implement against, close enough to the code that it shouldn't rot the way speculative architecture does.

These are pre-implementation docs. Anything still genuinely undecided is marked **OPEN** with the candidate options and a lean; settled calls are marked **DECIDED**. Don't treat an OPEN item as blocking. It means "decide when you get there, here's the shortlist."

## Phases

| Phase | Doc | Delivers |
|---|---|---|
| 0 | (decision pass) | v1 design locked in `docs/SPEC.md` + `docs/ROADMAP.md`: events as the only primitive on the wire, 4-table schema (`agents`, `sessions`, `participants`, `events`), WebSocket primary transport with an HTTP fallback, per-session event schema validated by the relay, server-stamped identity. No code. **Done.** |
| 1 | [`phase-1-skeleton-and-data.md`](./phase-1-skeleton-and-data.md) | Project skeleton, build tooling, the data layer: Prisma schema (the 4 models), migrations, the boot bootstrap, config/env. No HTTP beyond `GET /healthz`. |
| 2 | [`phase-2-relay-api.md`](./phase-2-relay-api.md) | The agent-facing HTTP + WebSocket API: `POST /v1/register`, `POST /v1/sessions`, `GET /v1/sessions/:id`, `PATCH /v1/sessions/:id/{schema,artifact}`, `DELETE /v1/sessions/:id`, `POST|GET /v1/sessions/:id/events`, `WS /v1/sessions/:id/stream`, `GET|DELETE /v1/keys`. Ajv schema validation. Identity stamping. Idempotency dedup. Signed best-effort webhooks. Error model, size caps. |
| 3 | [`phase-3-human-side.md`](./phase-3-human-side.md) | Everything a browser touches: `GET /s/:token` (the shell), `GET /s/:token/content` (the agent's artifact, sandboxed), the `pane.*` shim (`emit` / `on` / `state`), the postMessage protocol between iframe and shell, the WS connection lifecycle, and the CSP / security headers. The part the SPEC flags as "can't get wrong." |
| 4 | [`phase-4-mcp-ttl-deploy.md`](./phase-4-mcp-ttl-deploy.md) | The TTL sweeper, the npm-workspaces monorepo (`@pane/core` / `@pane/relay` / `@pane/cli`), the `pane` CLI (the first client wrapper — `create` / `state` / `send` / `watch`) replacing the originally-planned MCP server, the Dockerfile / single-container deploy, the `claudeclaw` dogfood, and the hosted-lite demo. |

## How each phase doc is laid out

1. **Scope**: what's in this phase, what's explicitly out (and which later phase or `/ee/` owns it).
2. **Architecture**: the design and the reasoning. Why this shape, what the alternatives were.
3. **Interfaces**: the exact contracts the code must satisfy. Prisma models, endpoint request/response shapes, the shim API, the CLI command surface, env vars.
4. **Acceptance criteria**: "this phase is done when..." Concrete, testable.
5. **Open decisions**: the unsettled calls, each with candidates and a lean. (Settled calls are noted DECIDED inline.)

## Cross-cutting constraints (apply to every phase)

- **Runtime-agnostic.** Node 20+ is the baseline. Bun must keep working. Use `node:`-prefixed imports, no Node-only APIs Bun lacks, ESM throughout.
- **Few dependencies.** Hono, `@prisma/client`, `@modelcontextprotocol/sdk`, `ajv` (per-session schema validation), `ws` (WebSocket server), `zod` (request-body parsing). That's the runtime dep list for v1. Resist adding more.
- **SQLite is the default and must never be optional in OSS.** Postgres is the hosted build only. Prisma is the data layer; no hand-rolled "Store interface with two impls."
- **The OSS core does the whole job, forever, no asterisks.** Nothing in v1 phones home, needs an account, or caps volume.
- **`/ee/` is out of scope for all of v1.** When a phase doc says "that's `/ee/`," it means: don't build it, don't design seams for it beyond what's free, note it and move on.
