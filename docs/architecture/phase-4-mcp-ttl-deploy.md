# Phase 4: TTL sweeper, MCP server, deploy, dogfood

## Scope

In:
- The TTL sweeper (periodic cleanup + lazy expiry on read).
- The MCP server (`src/mcp/server.ts`, the `pane-mcp` bin) and its tools: the first client wrapper.
- The Dockerfile + `.dockerignore` + single-container deploy story.
- The `claudeclaw` dogfood: wiring `pane-mcp` into a real claw instance and doing one genuine round trip.
- The hosted-lite demo instance.
- README polish + the 30-second demo clip + flipping the repo public + MIT license.

Out:
- The LangChain tool wrapper (v2).
- The proper hosted product: accounts, dashboard, billing, SLA, teams, roles, analytics (v2 / `/ee/`).
- SSE as a retrieval mode (v2).
- Multi-process sweeper coordination (v1 is single-process; flag for `/ee/`).

## TTL sweeper

- In `src/index.ts`: `setInterval` every `TTL_SWEEP_SECONDS` (default 60; `0` disables), with a little jitter, running `prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })`. The `Event` and `Participant` rows cascade away (`onDelete: Cascade`). Log a `debug` line with the count.
- Plus lazy expiry: `GET /v1/sessions/:id` already (phase 2) reports `status: "closed"` when `expiresAt < now` even if the row is still present, so a slow sweep never lies.
- Multi-process (the hosted build): only one process should sweep. A Postgres advisory lock, or `SELECT ... FOR UPDATE SKIP LOCKED`, or a dedicated worker. **Out of scope for v1** (single-process); note it for `/ee/`.
- **DECIDED**: interval + lazy-expiry-on-read; interval disable-able via env.

## MCP server

`src/mcp/server.ts`, exposed as a bin: `package.json` `"bin": { "pane-mcp": "dist/mcp/server.js" }`, so `npx pane-mcp` works once the package is published. Built on `@modelcontextprotocol/sdk`.

- **Transport**: stdio. The standard shape for "an MCP server an MCP host spawns." **DECIDED**: stdio only in v1; HTTP / SSE transport is later.
- **It is a client of the relay's HTTP / WS API, a separate process.** It holds `PANE_URL` and `PANE_API_KEY` (env), and calls `POST /v1/sessions`, `GET /v1/sessions/:id/events`, opens WS connections, etc. It does NOT embed the relay. **DECIDED**: separate process, talks to the relay over the network.

### The MCP tool surface

Three tools in v1; one candidate held for v2.

**`create_pane_session({ artifact, schema, ttl_seconds?, metadata?, callback? }) -> { session_id, urls, tokens, expires_at }`**. Wraps `POST /v1/sessions`. Returns the human URL(s) the calling agent must deliver to the human(s) over its own channel (Telegram, Slack, email).

**`await_pane_result({ session_id, terminal_event_type, timeout_seconds? }) -> { status: "received", event } | { status: "timeout" } | { status: "closed" }`**. Blocks via the relay's long-poll (`GET /v1/sessions/:id/events?wait=...`, looped with a cursor) until an event of `terminal_event_type` lands, or `timeout_seconds` (default 300, capped) elapses, or the session closes. Returns the matching event's full envelope. In v1, "submit" is not magic; the agent tells this tool which event type to wait for. The artifact's schema declares what that type is (e.g. `review.submitted`, `form.completed`).

**`get_pane_state({ session_id }) -> { status, schema_version, artifact_version, events: [<full envelopes>], next_cursor }`**. Non-blocking. Returns the full event log + session metadata for agents that don't want to hold a tool call open.

(v2 candidate: `emit_pane_event({ session_id, type, data, ... })`. v1 leaves event emission to direct HTTP from the calling agent. If the MCP host can't make outbound HTTPS, this would be needed; otherwise defer.)

### MCP server config & errors

- Env: `PANE_URL` (the relay base URL), `PANE_API_KEY`. Both required; the server refuses to start without them.
- Relay errors map to MCP tool errors: 401 → "auth failed, check PANE_API_KEY"; 404 on `await_pane_result` → "no such session or wrong agent"; 413 → "artifact / payload too large"; 422 with `code: "schema_violation"` → "schema violation: <ajv path>"; 410 → "session closed"; etc. Don't leak raw relay internals.
- Docs ship an example MCP-host config snippet (the `mcpServers` entry that points at `npx pane-mcp` with the two env vars).

## Dockerfile / deploy

Multi-stage, `node:20-slim` (Debian, glibc; matters for Prisma's query-engine binary; `debian-openssl-3.0.x` is the default and works on slim). **DECIDED**: slim, not Alpine. (Alpine = musl = needs `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` and more surprises; document for anyone who insists, but ship slim.)

```
# stage 1: build
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build            # tsc -> dist/

# stage 2: runtime
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma   # generated client
COPY prisma ./prisma
VOLUME /app/data             # the SQLite file lives here by default
EXPOSE 3000
# entrypoint: apply migrations, then start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
```

(Exact `COPY` lines for the generated Prisma client may need tweaking. Verify `npx prisma generate`'s output location against the pinned version. The principle: the runtime image has `dist/`, prod `node_modules`, the generated client, and `prisma/migrations/`.)

`.dockerignore`: `node_modules`, `dist`, `.git`, `data`, `*.db`, `.env*`.

Documented run:

```
docker run -p 3000:3000 \
  -e PUBLIC_URL=https://pane.example.com \
  -e API_KEY=pane_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  -v pane-data:/app/data \
  ghcr.io/<owner>/pane
```

With no `-e API_KEY`, the container prints a generated key once on first boot (phase-1 bootstrap); `docker logs` to grab it.

## claudeclaw dogfood

Wire `pane-mcp` into one `claudeclaw` instance's MCP config, pointed at a locally-running relay (or the hosted-lite one). The concrete first use: a heartbeat / agent task that needs Lalit to pick from options or review something richer than text. The claw builds an HTML artifact + schema (e.g. one event type `review.commentAdded` from `["page","agent"]` and one `review.submitted` from `["page"]`), calls `create_pane_session`, sends Lalit the URL over the existing Telegram channel (the claw already has that), then `await_pane_result({ terminal_event_type: "review.submitted" })`, then acts on the result. Bonus: the claw can also open the WS itself (using the agent token returned alongside the session) and reply to Lalit's comments live; the schema's `emittedBy: ["page", "agent"]` is what makes that possible.

This is the "does the round trip actually feel good?" test. Do it before anyone else touches the project.

## Hosted-lite demo

The same Docker image, run on Azure (Container Apps, on the credits). `PUBLIC_URL` = the assigned `*.azurecontainerapps.io` (or a cheap domain). For "people can try it without deploying": the cheapest v1 path that needs **no new code** is to set `REGISTRATION_SECRET` to a value documented on the demo page (so `POST /v1/register` works for anyone who reads the docs) and give issued agents a generous `rate_limit`. A proper anonymous, per-IP-rate-limited `/v1/register` (provisional keys) is more code and a hosted-product concern; defer. The shell page on the demo instance carries a banner: "demo instance. Data may vanish, no SLA, may change or disappear." **OPEN**: public-`REGISTRATION_SECRET` shortcut vs real anonymous registration. Lean: the shortcut.

## Acceptance criteria

- **Sweeper**: create a session with `ttl_seconds=2`, wait past one sweep interval → the session row and its events / participants are gone; `GET`-ing it during the gap returns `status: "closed"`.
- **MCP**: `npx pane-mcp` over stdio; an MCP client (the SDK's own client, or the `mcp` CLI) lists the tools, calls `create_pane_session` → gets `urls.humans`, a human opens one and emits a `review.submitted` event, `await_pane_result({ terminal_event_type: "review.submitted" })` returns the event. `get_pane_state` returns the same state without blocking.
- **Docker**: `docker build` then `docker run` with the documented env → relay up, migrations applied, `GET /healthz` → 200, a full session round-trip works against the container (HTTP for create, WS for bidirectional). After `docker restart`, prior data is still there (the volume).
- **claudeclaw**: one real round trip where Lalit answers via the UI and the claw acts on the resulting event. Bonus: the claw replies live to one of Lalit's comments via its own WS connection; Lalit sees the reply appear without refreshing.
- **hosted-lite**: a second machine (or a stranger) can `POST /v1/register` (with the documented secret), get a key, create a session, complete it, with zero involvement from Lalit.
- **Publish**: repo public, `LICENSE` is MIT, `README.md` has a working quickstart (`docker run ...`) and a short demo clip / gif.

## Open decisions

- **hosted-lite registration**: documented public `REGISTRATION_SECRET` + generous per-agent `rate_limit` (lean, no new code) vs real anonymous rate-limited `/v1/register`. OPEN.
- **`emit_pane_event` as an MCP tool**: skip in v1 (agents emit via direct HTTP) vs include for MCP hosts that can't make outbound HTTPS. OPEN; lean: skip.
- **Image registry**: GHCR vs Docker Hub for the published image. OPEN, low stakes.
- TTL sweeper design (interval + lazy-read), MCP transport (stdio), MCP-server-as-separate-process, three-tool surface (`create_pane_session` / `await_pane_result` / `get_pane_state`), Docker base (`node:20-slim`): all **DECIDED** above.
