# Pane: Technical Spec (v1)

Companion to the root `README.md` and `ROADMAP.md` (sibling). Supersedes the v0 sketch.

This spec describes Pane v1: the minimum protocol and implementation needed to ship the OSS core. The shape is locked, the details are open.

## Core idea

The agent generates and ships a UI artifact AND a per-session event schema. Humans and agents are peers connected to a single session. Every interaction (a human click, an agent reply) is an event. State is what you get by replaying events. The relay transports and validates; it does not interpret.

Three things change vs. v0:

1. Events are the only primitive. No separate `emit` / `submit` verbs. `submit` is one event type; the agent's reply is another, schema-defined.
2. Both sides write to the same UI symmetrically. The agent's reply to a human comment uses the same primitive the human used to post it.
3. The agent declares the session's event schema up front. The relay validates writes against it.

## Stack (unchanged from v0)

TypeScript. Runtime: Node 20+ (Bun fine; keep code runtime-agnostic). Web framework: Hono. ORM: Prisma. SQLite for self-host/default, PostgreSQL for the hosted build (dialect selected at build time via `schema.prisma` provider). MCP server via `@modelcontextprotocol/sdk`. Minimal dependencies.

## Roles

- **Agent**: any process that wants to give a human a rich UI. No public address; only outbound HTTPS or WS calls. Owns the artifact and the schema for the sessions it creates.
- **Relay**: the Pane service. Public URL. Stores sessions and events. Serves the shell page that loads the artifact. Transports and validates events. Self-host (Docker + SQLite) or hosted (Postgres).
- **Human**: opens a URL in any browser; interacts with the artifact. Multiple humans can share a session.

## Identity

Every connection authenticates with a token issued by the relay at session creation. Each token names one identity:

- `human:<id>` (browser; one token per invited human)
- `agent:<id>` (the agent that created the session)
- `system` (relay-emitted only)

The relay stamps `author` on every accepted event from the auth context. Clients cannot spoof author.

## Event (the only primitive)

Wire shape, identical across both transports:

```json
{
  "id":              "evt_<ulid>",
  "session_id":     "<id>",
  "author":          { "kind": "human|agent|system", "id": "<id>" },
  "ts":              "2026-05-13T14:30:52.000Z",
  "type":            "<namespace.name>",
  "data":            { "...": "per the session's schema" },
  "causation_id":    "evt_... or null",
  "idempotency_key": "<optional>"
}
```

Field rules:

- `id`, `ts`, `author` are stamped server-side. The writer omits them.
- `type` must exist in the session's event schema. 422 otherwise.
- `data` must validate against the type's payload schema. 422 otherwise.
- `author.kind` must be in the type's `emittedBy`. 403 otherwise.
- `causation_id` is the event id that triggered this one. Optional. Stored verbatim; not validated for existence (it is metadata).
- `idempotency_key` is optional. If `(session_id, author_id, key)` was seen before, return the existing event id with 200 (not 201).

System events (relay-only; not writable by agent or page):

| Type | Payload |
|---|---|
| `system.participant.joined` | `{ author }` |
| `system.participant.left`   | `{ author }` |
| `system.artifact.updated`   | `{ version, source_hash }` |
| `system.schema.updated`     | `{ version, added: [type names] }` |
| `system.session.expired`    | `{}` |

`system.participant.left` is written fire-and-forget when a WebSocket closes,
so a relay crash/restart between connect and close can lose it, leaving an
orphan `joined`. To keep the log self-consistent the relay reconciles on
startup: with zero live connections, every unpaired `joined` on an open session
is provably stale, so a synthetic `system.participant.left` is emitted for each
surplus `joined` (paired per `author`). Presence counts (`agentCountLive`) are
tracked from connection lifecycle, never derived from this log.

## Per-session event schema

The agent ships this at session creation. Shape:

```json
{
  "events": {
    "review.commentAdded": {
      "payload":   { "...JSON Schema..." },
      "emittedBy": ["page", "agent"]
    },
    "review.approved": {
      "payload":   { "approver": { "type": "string" } },
      "emittedBy": ["page"]
    },
    "highlight.requested": {
      "payload":   { "selector": { "type": "string" } },
      "emittedBy": ["agent"]
    }
  }
}
```

- `emittedBy`: which actor kinds may write the type. `"page"` covers any human peer; `"agent"` covers any agent peer. `"system"` is reserved.
- No global event registry. Each session owns its vocabulary. An agent that wants stable cross-session types simply ships the same schema each time.
- Schema can be PATCHed mid-session (additive only). The relay emits `system.schema.updated`.
- The relay uses Ajv to validate `data` against the type's `payload`.

## Artifact

The HTML/JS the agent generated for this session. v1 formats:

| Type | Source |
|---|---|
| `html-inline` | A single string of HTML/CSS/JS, capped 2 MB. Served as-is. |
| `html-ref`    | An opaque URL the agent uploaded elsewhere; relay fetches and caches. |

Same sandbox rules apply to both. Not in v1: React bundles, runtime compilers, server-rendered frameworks.

`PATCH /v1/sessions/{id}/artifact` replaces it; relay emits `system.artifact.updated`. The shell page reloads the iframe. The event log is preserved across reloads.

## Sandbox

The artifact is treated as hostile by default (LLM-generated). The relay enforces:

- Iframe `sandbox="allow-scripts"`. No `allow-same-origin`, no `allow-top-navigation`, no `allow-forms`.
- CSP on `/s/{token}/content`: `default-src 'self'; script-src 'unsafe-inline'; connect-src 'none'; img-src data: 'self'; style-src 'unsafe-inline' 'self'`.
- No external network. The artifact's only escape is `postMessage` to the shell page.
- `frame-ancestors` on relay's own pages.
- HTML served only through the relay endpoint (never a raw URL with bypassable headers).
- HTML size cap (2 MB); event `data` cap (64 KB).

## Bridge

The shell page (outside the iframe) holds the WebSocket and the token. The bridge shim, served alongside the shell, exposes `pane` to the artifact via `postMessage`:

```ts
pane.emit(type, data, opts?): Promise<{ id }>
pane.on(type, handler): unsubscribe
pane.state: ReadonlyEventLog
```

`opts.causationId` tags the parent event. `opts.idempotencyKey` makes the write retry-safe.

The shell page:

1. Opens a WS to the relay using the human's token.
2. Replays events into local state on connect.
3. Forwards new events to the iframe via `postMessage` (filtered to public types).
4. Receives `pane.emit` calls from the iframe via `postMessage`, validates origin, forwards to WS.

The artifact never sees the token.

## Transports

Two, interchangeable, same event shape.

### WebSocket (primary)

```
WS /v1/sessions/{id}/stream
Auth: ?ticket=<ws_ticket>  (browser path, preferred)
  or  Authorization: Bearer <token> / ?token=<token>  (non-browser clients)

on open  → server replays event log from cursor=0
server → { id, session_id, author, ts, type, data, causation_id, idempotency_key }
client → { type, data, causation_id?, idempotency_key? }
```

Browsers cannot set an `Authorization` header on `new WebSocket()`, so the WS
URL must carry the credential as a query parameter. A long-lived token there
leaks into upstream reverse-proxy access logs. The browser path therefore uses
a **short-lived ticket**: the client first calls `POST /v1/sessions/{id}/ws-ticket`
(authenticated with the real token), receives a single-use ticket with a 30s
TTL bound to that (identity, session), then opens the WebSocket with
`?ticket=<ticket>`. The ticket is consumed on upgrade. Non-browser clients
(e.g. the agent CLI) may still pass the real token via `Authorization` or
`?token=` directly.

**Self-echo before ack.** When a WS client emits a frame, the relay inserts and
broadcasts the event *before* sending the ack back to the emitter. The sender
therefore receives its own event echoed on the same connection, and that echo
arrives ahead of the ack for the emit. Clients that both send and receive on one
connection — multiplexed agents, the page bridge shim — must dedupe by event id
(`event.id` vs the `id` returned in the ack).

**Slow-client backpressure (v1 limitation).** The relay broadcasts synchronously
to every subscribed socket; each subscriber gets a plain `ws.send()`. v1 has no
backpressure: large session event rates against slow connections may grow the
per-socket send buffer unbounded, since the `ws` library queues data internally
when a socket is not draining. The v2 fix is a per-socket `bufferedAmount`
threshold — when a socket exceeds it, `terminate()` that one slow client (drop
the offending connection only, not the whole session).

### HTTP POST + cursor read (stateless fallback)

```
POST /v1/sessions/{id}/events
  Authorization: Bearer <token>
  Body: { type, data, causation_id?, idempotency_key? }
  → 201 { event: ... }

GET /v1/sessions/{id}/events?since=<cursor>&wait=<seconds>
  Authorization: Bearer <token>
  → 200 { events: [...], cursor: <opaque> }
```

A stateless agent reads via `?wait=30` (long-poll) or callback. A long-running agent (a claw, an open Claude Code session) holds a WS.

## Callbacks (optional)

Agents that cannot poll or hold a WS register a webhook at session creation:

```json
"callback": {
  "url":     "https://my-agent/pane",
  "events":  ["review.*", "approval.*"],
  "secret":  "<HMAC shared secret>"
}
```

The relay POSTs `{ session_id, event }` for each matching event. Signed `X-Pane-Signature: sha256=<hmac of timestamp.body>`. Retries 3x with exponential backoff. Durable delivery (dead-letter, replay) is a hosted feature.

## HTTP API (v1)

All agent endpoints require `Authorization: Bearer <api_key>` from `agents`.

| Method | Path | Description |
|---|---|---|
| `POST`   | `/v1/register` | Self-provision an API key. Gated by `REGISTRATION_MODE`: `closed` (default) → 404; `secret` → requires a bearer registration secret; `open` → public, per-IP rate-limited. |
| `POST`   | `/v1/sessions` | Create session (artifact + schema + participants). |
| `GET`    | `/v1/sessions/{id}` | Session metadata. |
| `PATCH`  | `/v1/sessions/{id}/schema`   | Additive schema update. |
| `PATCH`  | `/v1/sessions/{id}/artifact` | Replace artifact. |
| `DELETE` | `/v1/sessions/{id}` | End session. |
| `POST`   | `/v1/sessions/{id}/events` | Write one event. |
| `GET`    | `/v1/sessions/{id}/events?since=<cur>&wait=<s>` | Read events. Long-poll. |
| `POST`   | `/v1/sessions/{id}/ws-ticket` | Mint a short-lived (30s), single-use WebSocket upgrade ticket. |
| `WS`     | `/v1/sessions/{id}/stream` | Bidirectional event stream. |
| `GET`    | `/keys` | List the calling agent's keys. |
| `DELETE` | `/keys/{id}` | Revoke. |

Human-facing (no agent auth; URL token IS the auth):

| Method | Path | Description |
|---|---|---|
| `GET` | `/s/{human_token}`         | Shell page. Loads bridge + iframe. |
| `GET` | `/s/{human_token}/content` | Streams artifact under sandbox CSP. |

### `POST /v1/sessions` request

```json
{
  "artifact": {
    "type":   "html-inline",
    "source": "<...html...>"
  },
  "schema": {
    "events": {
      "review.commentAdded": {
        "payload":   { "...": "JSON Schema" },
        "emittedBy": ["page", "agent"]
      }
    }
  },
  "participants": { "humans": 1 },
  "ttl":         3600,
  "metadata":    { "label": "PR #42 review" },
  "callback":    { "url": "...", "events": ["..."], "secret": "..." }
}
```

`participants.humans` is a count; the relay issues that many human tokens. The agent that created the session is implicitly the only agent participant. Multi-agent sessions are v2.

### `POST /v1/sessions` response

```json
{
  "session_id": "ses_...",
  "tokens": {
    "humans": ["tok_h_..."],
    "agent":  "tok_a_..."
  },
  "urls": {
    "humans":       ["https://pane.relay/s/tok_h_..."],
    "agent_stream": "wss://pane.relay/v1/sessions/ses_.../stream"
  },
  "expires_at": "2026-05-13T..."
}
```

## Data model (v1)

```
agents 1 ──< sessions 1 ──< events
                       1 ──< participants
```

### `agents` (one row per API key issued)

| column | notes |
|---|---|
| `id`            | cuid. FK target. |
| `name`          | human label. |
| `key_hash`      | sha256(api_key), unique. |
| `key_prefix`    | display only. |
| `created_at`    | |
| `last_used_at`  | nullable. |
| `revoked_at`    | nullable; non-null = revoked. |
| `rate_limit`    | nullable int. Per-agent sessions-per-hour cap. |

### `sessions`

| column | notes |
|---|---|
| `id`                   | cuid. |
| `agent_id`             | FK → `agents`. |
| `artifact_type`        | `html-inline` or `html-ref`. |
| `artifact_source`      | TEXT (inline) or URL (ref); capped 2 MB. |
| `artifact_version`     | int; bumps on PATCH. |
| `event_schema`         | JSON. The per-session vocabulary. |
| `schema_version`       | int. |
| `status`               | `open` or `closed`. |
| `created_at`           | |
| `expires_at`           | |
| `metadata`             | JSON. |
| `callback_url`         | nullable. |
| `callback_secret_hash` | nullable. |
| `callback_filter`      | nullable. |

### `participants` (one row per identity that may connect)

| column | notes |
|---|---|
| `id`             | cuid. |
| `session_id`     | FK → `sessions`. |
| `kind`           | `human` or `agent`. |
| `identity_id`    | the value in `author.id`. |
| `token_hash`     | sha256 of the auth token. |
| `token_prefix`   | display only. |
| `joined_at`      | nullable; stamped on the first **WebSocket** connect only. HTTP polling of `GET /v1/sessions/:id/events` does not count as joining. |
| `revoked_at`     | nullable. |

### `events`

| column | notes |
|---|---|
| `id`              | BIGINT autoincrement. Doubles as the poll cursor (API exposes it as opaque). |
| `session_id`      | FK → `sessions`, ON DELETE CASCADE. |
| `author_kind`     | `human` / `agent` / `system`. |
| `author_id`       | participant identity. |
| `type`            | text. |
| `data`            | JSON. |
| `causation_id`    | nullable; not constrained (metadata only). |
| `idempotency_key` | nullable. |
| `ts`              | timestamp. |
| Unique            | `(session_id, author_id, idempotency_key)` where `idempotency_key NOT NULL`. |
| Index             | `(session_id, id)` for cursor reads. |

TTL cleanup: hourly `DELETE FROM sessions WHERE expires_at < now()`. Cascades to `events` and `participants`.

(Hosted-only later, in `/ee/`: `orgs`, `projects`, scoped api_keys, quotas, audit log.)

## Validation flow

Every write (POST or WS message) runs:

1. Decode token; resolve `participant`. 401 if invalid or revoked.
2. Check `session.status == 'open'`. 410 otherwise.
3. Lookup `type` in `session.event_schema`. 422 if missing.
4. Check `participant.kind ∈ type.emittedBy`. 403 if not.
5. Validate `data` against the type's `payload` schema (Ajv). 422 with the failed path on error.
6. Idempotency check: if `(session_id, author_id, idempotency_key)` exists, return that event_id with status 200. Else proceed.
7. Insert event row; stamp `id`, `ts`, `author` server-side.
8. Broadcast to every participant WS socket in the session.
9. Fire callback if `callback_filter` matches.

## Auth (three layers; only #1 and #2 in v1)

1. **Agent → relay**: bearer token in the `agents` table. Issued via `POST /register`, whose exposure is operator-configurable through `REGISTRATION_MODE`: `closed` by default (endpoint 404s — keys come from `API_KEY` / auto-mint), `secret` (bearer registration secret required), or `open` (public, per-IP rate-limited). `sha256(key) + prefix` stored. Bump `last_used_at` on each request. Revocable via `DELETE /keys/{id}`.
2. **Participant → session**: per-identity token issued at `POST /sessions` time. Stored as `sha256(token)` in `participants.token_hash`. URL token IS the auth for humans.
3. **Multi-tenancy / roles / orgs / SSO**: hosted only, v2+.

## Security checklist

- Iframe `sandbox="allow-scripts"` only. No `allow-same-origin` (cookies + parent DOM remain unreachable).
- CSP `connect-src 'none'` on `/s/{token}/content`: artifact has no external network.
- `frame-ancestors` on relay's own pages.
- HTML served only through the relay endpoint.
- HTML size cap (2 MB); event data cap (64 KB).
- Per-agent session-create rate limit.
- Token entropy 128 bits, base32 encoded.
- Webhook signatures HMAC-SHA256 over `timestamp.body`, 5-minute replay window.
- `postMessage` origin check on the shell-iframe boundary.
- Schema validation rejects writes outside the declared vocabulary, so LLM-generated artifacts cannot exfiltrate via custom event types.

## Open/closed line (open-core)

Principle: the OSS version must do the whole job, end to end, for one user, on their own server, forever, no asterisks. Never cap volume on self-host. Never phone home. The bridge protocol stays fully open.

**OSS (MIT, default build):**

- Single-container relay (Docker + SQLite).
- All transports: WS, HTTP POST + long-poll, best-effort signed webhook.
- Schema validation, identity stamping, sandbox.
- Bearer auth, key issuance, revocation, `POST /register` gated by `REGISTRATION_MODE` (closed default / secret / open) with per-IP rate limiting in the secret and open modes.
- MCP server wrapping `create_pane_session(artifact, schema)` and `await_pane_result(session_id, terminal_event_type)`.
- Reference demo: a `claudeclaw` integration that lets the agent ask Lalit something through a UI.

**Hosted / `/ee/`:**

- Console: browse sessions, replay timelines, analytics (open rate, time-to-answer, completion rate), search.
- Orgs, projects, scoped api_keys, usage quotas, billing.
- Participant access control: SSO, magic-link, "only user X can open this".
- Robust webhook delivery: dead-letter queue, replay, configurable retry. Signing is already in OSS.
- Higher limits, SLA, SOC2, EU data residency, support.

**Code-sharing:** one repo, MIT/Apache core, `/ee/` directory under a commercial license. Default build excludes `/ee/`. License-key gate only for enterprise features that run in self-host. Clean seams (auth, storage, event delivery) so `/ee/` plugs in without monkey-patches.

**License:** MIT or Apache on the core. Hosted-only code in a private repo. Skip BSL.

---

That's v1. Ship the OSS core in a weekend, dogfood in a claw, hosted-lite demo on Azure credits.
