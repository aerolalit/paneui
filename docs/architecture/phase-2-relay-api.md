# Phase 2: The relay API

## Scope

In:
- The Hono app + server wiring (`src/http/app.ts`, mounted by `src/index.ts`).
- The bearer-auth middleware (`src/http/auth.ts`) for agent endpoints, plus the dual-auth path for the events endpoints (agent bearer OR participant token).
- The error model (`src/http/errors.ts`).
- The agent-facing endpoints: `POST /v1/register`, `POST /v1/sessions`, `GET /v1/sessions/:id`, `PATCH /v1/sessions/:id/schema`, `PATCH /v1/sessions/:id/artifact`, `DELETE /v1/sessions/:id`, `POST /v1/sessions/:id/events`, `GET /v1/sessions/:id/events`, `GET /v1/keys`, `DELETE /v1/keys/:id`.
- The WebSocket transport: `WS /v1/sessions/:id/stream`. Bidirectional, with token auth, replay-on-connect, and broadcast to every connected participant.
- Schema validation (Ajv against the per-session event schema), identity stamping, idempotency dedup.
- Best-effort signed webhook delivery for `callback`.
- Size caps, ownership checks, the long-poll variant of the events read.
- Integration tests against a temp SQLite DB.

Out:
- `GET /s/:token` and `GET /s/:token/content` and everything about rendering / the iframe / CSP / the shim (phase 3). The WS connection from the shell is initiated in phase 3 against the endpoint defined here.
- Durable webhook delivery (dead-letter, replay): `/ee/`.
- SSE: `/ee/` / v2.

## Architecture

### App wiring

- One Hono `app` in `src/http/app.ts`. `src/index.ts` builds it (passing `config`, `prisma`) and serves it via `@hono/node-server`. The WebSocket server (`ws` package) attaches to the same HTTP server in `src/ws/handler.ts`.
- Global middleware order: (1) request-id (generate + echo `X-Request-Id`), (2) access log (`log.info` method/path/status/ms; never the body), (3) the error handler (catches thrown `ApiError` and unknown errors). Then route groups.
- `GET /healthz`: no auth, no logging noise (or `debug` level).
- `/v1/register` is always mounted but its behaviour is operator-configurable via `REGISTRATION_MODE`, enforced inside the route module: `closed` (default) returns 404 so a self-host relay exposes no public registration; `secret` requires an `Authorization: Bearer <REGISTRATION_SECRET>` token (missing/wrong → 401); `open` is public self-service. The per-IP sliding-window rate limiter runs in the `secret` and `open` modes.
- `/v1/sessions/*` (agent-creator endpoints) and `/v1/keys/*` get the agent-bearer middleware.
- `POST /v1/sessions/:id/events` and `GET /v1/sessions/:id/events`: dual-auth. The bearer is resolved against EITHER `agents.keyHash` OR `participants.tokenHash`. Whichever wins, the resulting `author` (`{ kind, id }`) is attached to the request. Mismatch (a participant token for a different session, an agent token for a session the agent doesn't own) → `404 not_found`.
- `WS /v1/sessions/:id/stream`: the upgrade handshake validates the bearer the same way (agent OR participant), attaches `author` to the connection, sends the full event-log replay, then enters the bidirectional loop.

### Auth middleware (`src/http/auth.ts`)

The agent-bearer flow (for `/v1/keys/*` and the agent-only operations on `/v1/sessions/*`):

```
1. read `Authorization: Bearer <key>`. Missing/malformed -> 401 unauthorized.
2. h = hashKey(key); agent = await prisma.agent.findUnique({ where: { keyHash: h } }).
3. !agent || agent.revokedAt != null  -> 401 unauthorized.  (one response for "no such key" and "revoked"; don't distinguish.)
4. c.set("agent", agent); c.set("author", { kind: "agent", id: agent.id }).
5. fire-and-forget: prisma.agent.update({ where: { id: agent.id }, data: { lastUsedAt: new Date() } }).catch(() => {});   // do NOT await
6. await next().
```

The dual-auth flow (for the events endpoints and the WS upgrade): hash the bearer once, look it up in both `agents.keyHash` and `participants.tokenHash`. If it's an Agent: verify `session.agentId === agent.id`. If it's a Participant: verify `participant.sessionId === req.params.id`. Either way, set `c.set("author", { kind, id })`. A mismatch in either flavour → `404 not_found` (don't reveal which case it is).

`lastUsedAt`: updated on every authed agent request, fire-and-forget. The `agents` table is tiny and the write is off the request path. **OPEN**: if write amplification on SQLite ever shows up, debounce it (in-memory "last bumped at" per agent, write at most once / minute). Not worth it pre-emptively.

### Error model (`src/http/errors.ts`)

- `class ApiError extends Error { constructor(public status: number, public code: string, message?: string, public details?: unknown) }`.
- The error-handler middleware: if `err instanceof ApiError` → `c.json({ error: { code, message, details } }, status)`. If `err` is a `zod` `ZodError` → `400 { error: { code: "invalid_request", details: err.flatten() } }`. If `err` is an Ajv validation failure on event `data` → `422 { error: { code: "schema_violation", details: { instancePath, schemaPath, message } } }`. Anything else → `log.error(err)` then `500 { error: { code: "internal" } }` (no message, no stack; don't leak).
- Standard codes in v1: `unauthorized` (401), `forbidden` (403), `not_found` (404), `invalid_request` (400), `payload_too_large` (413), `conflict` (409), `gone` (410, for closed sessions), `schema_violation` (422), `internal` (500).

### Token generation

- Agent API keys: `"pane_" + randomBytes(16).hex()` (128 bits, 37 chars).
- Participant tokens: `base64url(randomBytes(32))` (256 bits, ~43 chars). Issued at `POST /v1/sessions` time. These are the only access control on the anonymous human links; high-entropy and never logged at info level.

### Schema validation (`src/http/validation.ts`)

For every event write:

1. Look up `type` in `session.eventSchema.events`. Miss → `422 { code: "unknown_event_type" }`.
2. Look up the type's `emittedBy`. If `author.kind` not in it → `403 { code: "author_not_allowed" }`.
3. Compile the type's `payload` JSON Schema once per session (cached in-memory by `sessionId + schemaVersion`), validate `data` against it. Failure → `422 schema_violation` with the Ajv error path.
4. Size cap: `Buffer.byteLength(JSON.stringify(data)) <= MAX_EVENT_DATA_BYTES` else `413 payload_too_large`.

Ajv is configured `strict: true, allErrors: false, removeAdditional: false`. We don't mutate the payload.

System events (`system.*`) bypass schema validation; only the relay writes them, with a fixed in-code schema.

### Identity stamping

On every accepted event write (POST or WS), the relay stamps `author` from the auth context. The writer cannot set or override `author`. Same for `id` (BIGINT autoincrement) and `ts` (server `now()`). `causationId` and `idempotencyKey` come from the writer (length-capped strings).

### Idempotency dedup

If the writer provides `idempotencyKey`, the insert is wrapped in `prisma.$transaction`:

```ts
const existing = await prisma.event.findUnique({
  where: { sessionId_authorId_idempotencyKey: { sessionId, authorId: author.id, idempotencyKey } }
});
if (existing) return { event: existing, deduped: true };
const event = await prisma.event.create({ ... });
return { event, deduped: false };
```

Wire response: `201 { event }` on insert; `200 { event, deduped: true }` on idempotency hit. The agent can ignore the distinction.

### Concurrency / SQLite

- SQLite is single-writer; fine for v1's load. Wrap "insert the event + (maybe) update session.status" in `prisma.$transaction([...])`. Same code path holds on Postgres.
- Broadcast: an in-process `EventEmitter` keyed by `sessionId`. After the transaction commits, emit the new event; the WS handler subscribes on connect and pushes to every open socket for the session. Long-poll waiters subscribe to the same emitter, race a `setTimeout(N s)`, and on either resolution re-query the DB for events after `since`.
- **OPEN**: alternative for long-poll is a dumb DB-poll loop (re-query every ~500 ms up to N s); the EventEmitter is tighter and fine for single-process v1. (Multi-process hosted needs real pub/sub or sticky routing; `/ee/`.)
- **OPEN**: broadcast policy. Fire-and-forget parallel sends to every socket (lean) vs serialized awaits (back-pressure-safe but slower). Lean: parallel.

### BigInt serialization

Never pass a Prisma row containing `Event.id` (a `BigInt`) to `c.json()`; it throws. A `serializeEvent(e)` helper:

```ts
{
  id:               String(e.id),
  session_id:       e.sessionId,
  author:           { kind: e.authorKind, id: e.authorId },
  ts:               e.ts.toISOString(),
  type:             e.type,
  data:             e.data,
  causation_id:     e.causationId,
  idempotency_key:  e.idempotencyKey
}
```

Used everywhere events go out (HTTP responses, WS frames, webhook bodies). The `?since=` cursor coming in is parsed with `BigInt(since)` inside a try/catch → `400 invalid_request` on garbage.

### Webhook delivery (best-effort, signed)

After each accepted event, if `session.callbackUrl` is set and `session.callbackFilter` matches the event `type` (glob match, e.g. `review.*`):

- Decrypt the stored secret (`session.callbackSecretEnc`) with the config-driven encryption key.
- `ts = Math.floor(Date.now() / 1000)`, `body = JSON.stringify({ session_id, event: serializeEvent(event) })`, `sig = hmacSha256(secret, ts + "." + body)`.
- POST: `{ url: callbackUrl, headers: { "content-type": "application/json", "X-Pane-Timestamp": ts, "X-Pane-Signature": "sha256=" + sig } }`. Fire-and-forget.
- Retries: 2 retries on network error or non-2xx, exponential backoff (1s, 3s). Then give up. Failures `log.warn`. The agent's WS or long-poll is the reliable path.

Encryption at rest: a small wrapper in `src/http/secrets.ts` using AES-256-GCM with a key from `CALLBACK_SECRET_KEY` (env var, 32 bytes, base64). If the env var is unset, callbacks are stored unencrypted and webhooks ship unsigned (`X-Pane-Signature: none`); the relay logs a `warn` at boot. **OPEN**: ship encryption mandatory (refuse callbacks if `CALLBACK_SECRET_KEY` unset) vs the warn-and-allow-unsigned fallback. Lean: warn-and-allow (one fewer required env on the happy path).

## Interfaces: the endpoints

All bodies are JSON. All timestamps are ISO-8601 strings on the wire. `:id` for sessions is the cuid in the URL, NOT the human token (that's only on `/s/:token`).

### `GET /healthz`
No auth. → `200 { "status": "ok" }`.

### `POST /v1/register`
Gated by `REGISTRATION_MODE`: `closed` (default) → 404; `secret` → requires
`Authorization: Bearer <REGISTRATION_SECRET>` (missing/wrong → 401); `open` →
public. Abuse is bounded by a per-IP rate limiter in the `secret` and `open`
modes.
Body: `{ "name"?: string }` (optional — a bare request sends none).
- `name`: defaults to `"registered"`; length-capped (≤ 64 chars).
Effect: `key = generateApiKey()`; `agent = prisma.agent.create({ name, keyHash: hashKey(key), keyPrefix: keyPrefix(key) })`.
→ `201 { "agent_id": agent.id, "api_key": key, "key_prefix": agent.keyPrefix }`. The raw `api_key` is returned exactly once.

### `POST /v1/sessions`
Auth: agent bearer.
Body:
```json
{
  "artifact": {
    "type":   "html-inline",
    "source": "<...html...>"
  },
  "schema": {
    "events": {
      "review.commentAdded": {
        "payload":   { "type": "object", "properties": { "paragraphId": {"type":"string"}, "body": {"type":"string"} }, "required": ["paragraphId","body"], "additionalProperties": false },
        "emittedBy": ["page", "agent"]
      }
    }
  },
  "participants": { "humans": 1 },
  "ttl":          3600,
  "metadata":     { "label": "PR #42 review" },
  "callback":     { "url": "...", "events": ["review.*"], "secret": "..." }
}
```

- `artifact.source`: required, non-empty. For `html-inline`: `byteLength <= MAX_ARTIFACT_BYTES`. For `html-ref`: a valid `http:` / `https:` URL.
- `schema.events`: required, non-empty. Each key matches `^[a-z][a-z0-9.]*[a-z0-9]$` (lowercase namespaced). Each value: a valid JSON Schema in `payload` (Ajv compiles at create time as a sanity check; failure → `400 invalid_request`) and a non-empty `emittedBy ⊆ ["page", "agent"]`.
- `participants.humans`: integer, `[1, MAX_PARTICIPANTS_PER_SESSION]`. (The creating agent is implicitly the only agent participant. Multi-agent is v2.)
- `ttl`: integer, clamped to `[1, MAX_TTL_SECONDS]`; default `DEFAULT_TTL_SECONDS`.
- `callback`: optional. If present, all three fields required. `events` is an array of glob patterns. `secret` is encrypted at rest (see Webhook delivery).

Effect (one `prisma.$transaction`):
- `session = prisma.session.create({ id: cuid(), agentId, artifactType, artifactSource, eventSchema, expiresAt, metadata, callbackUrl?, callbackSecretEnc?, callbackFilter? })`.
- For the creating agent: one `Participant { kind: "agent", identityId: agent.id, tokenHash: hashKey(agentToken), tokenPrefix: keyPrefix(agentToken) }` with a freshly minted `agentToken = generateToken()`.
- For each human seat (`participants.humans`): one `Participant { kind: "human", identityId: cuid(), ... }` with its own token.

→ `201`:
```json
{
  "session_id": "ses_...",
  "tokens": {
    "humans": ["tok_h_..."],
    "agent":  "tok_a_..."
  },
  "urls": {
    "humans":       ["${PUBLIC_URL}/s/${humanToken}"],
    "agent_stream": "${WS_URL}/v1/sessions/${session_id}/stream"
  },
  "expires_at": "..."
}
```

`WS_URL` is `PUBLIC_URL` with `http` → `ws`, `https` → `wss`. Returned for convenience; the agent could compute it.

### `GET /v1/sessions/:id`
Auth: agent bearer + ownership.
If `session.status === "open"` but `session.expiresAt < now` → reports `status: "closed"` (lazy expiry covers the gap before the sweeper).
→ `200 { "session_id", "status", "schema_version", "artifact_version", "metadata", "created_at", "expires_at" }`. No `artifact_source` (it can be 2 MB; the agent already has it). No `event_schema` (same reason).

### `PATCH /v1/sessions/:id/schema`
Auth: agent bearer + ownership.
Body: `{ "add": { "events": { ... } } }`. Adds new event types or extends existing payloads to a strict superset. Removing types or making payloads stricter → `400 invalid_request` with the path that broke. Effect: `prisma.session.update({ data: { eventSchema: <merged>, schemaVersion: { increment: 1 } } })`. Emit `system.schema.updated`.
→ `200 { "schema_version": <new> }`.

### `PATCH /v1/sessions/:id/artifact`
Auth: agent bearer + ownership.
Body: `{ "artifact": { "type": ..., "source": ... } }`. Same caps as creation. Effect: `prisma.session.update({ data: { artifactType, artifactSource, artifactVersion: { increment: 1 } } })`. Emit `system.artifact.updated` so connected clients can reload.
→ `200 { "artifact_version": <new> }`.

### `DELETE /v1/sessions/:id`
Auth: agent bearer + ownership.
Effect: `prisma.session.update({ data: { status: "closed", expiresAt: new Date() } })`. Emit `system.session.expired`. **DECIDED**: soft-close (status flip), don't hard-delete. The TTL sweeper collects later.
→ `204`.

### `POST /v1/sessions/:id/events`
Auth: dual (agent bearer of the creator, OR participant token of a participant). The bearer determines `author`.
Body: `{ "type": string, "data": object, "causation_id"?: string, "idempotency_key"?: string }`.
- Session must exist (404). `status === "open"` else `410 gone`.
- Run the schema validation flow. Possible: `422 schema_violation` (with `code: "unknown_event_type" | "author_not_allowed" | <ajv detail>`), `413 payload_too_large`.
- Idempotency check.

Effect (`prisma.$transaction`):
- Insert the event; author stamped from auth context.

After commit:
- Emit on the in-process emitter (wakes WS subscribers + long-poll waiters).
- Fire callback if it matches.

→ `201 { "event": <serializeEvent> }` on insert. `200 { "event": <existing>, "deduped": true }` on idempotency hit.

### `GET /v1/sessions/:id/events?since=<cursor>&wait=<seconds>`
Auth: dual (same as POST events).
- `since`: optional opaque string (stringified `Event.id`); absent ⇒ from the start. Invalid → `400 invalid_request`.
- `wait`: integer, clamped `[0, 30]`, default `0`.

Query: `prisma.event.findMany({ where: { sessionId, ...(since ? { id: { gt: BigInt(since) } } : {}) }, orderBy: { id: "asc" }, take: 500 })`.

- If non-empty, or `wait === 0`: respond now.
- If empty and `wait > 0`: subscribe to the in-process emitter for `sessionId`, race a `wait`-second timeout, then re-query once and respond.

→ `200 { "events": [...], "next_cursor": string | null }`. `next_cursor` = the last returned event's id as a string; if no events were returned, echo back `since` (or `null` if absent).

### `WS /v1/sessions/:id/stream`
Auth: dual (same as POST events; the bearer is in the HTTP upgrade headers, or as a `?token=` query param when used from a browser, see phase 3).

On open:
1. Resolve auth → stamp `author` on the connection.
2. Stamp `participant.joinedAt = now()` if not set.
3. Emit `system.participant.joined { author }` (persists as an event and broadcasts).
4. Replay: stream every event from `id=0` up to the session's current head. Each frame is one `serializeEvent`. After the replay, send a `{ "kind": "system.replay.complete" }` control frame so the client knows it's caught up. (Control frames are not stored.)
5. Subscribe to the broadcast emitter for `sessionId`. Forward live events.

Client → server frames: `{ type, data, causation_id?, idempotency_key? }`. The handler runs the same validation flow as `POST /events` and replies on the socket with one of:

```json
{ "ack": <event_id>, "deduped": false }
{ "ack": <event_id>, "deduped": true }
{ "error": { "code": "...", "message": "...", "details": { ... } } }
```

On close: emit `system.participant.left { author }`. Don't revoke the participant token; a reconnect should work.

### `GET /v1/keys`
Auth: agent bearer. Returns the calling agent's row.
→ `200 { "agent_id", "name", "key_prefix", "created_at", "last_used_at", "revoked_at" }`. (One agent == one key in v1.)

### `DELETE /v1/keys/:id`
Auth: agent bearer. Allowed only if `:id === c.get("agent").id` (you can revoke yourself; admin-revoking-others is `/ee/`); else `403`.
Effect: `prisma.agent.update({ data: { revokedAt: new Date() } })`. The next request with that key fails auth.
→ `204`.

## Acceptance criteria

- **Full happy path** (a test and a documented `curl + wscat` script): `POST /v1/register` → `POST /v1/sessions` (artifact + a `review.commentAdded` event type from `["page","agent"]`) → human token in response → open `wscat` against `WS /v1/sessions/:id/stream` with `?token=<human_token>` → receive `system.participant.joined` and the replay-complete control frame → send `{ "type": "review.commentAdded", "data": { ... } }` → receive `{ack: ...}` back on the same socket → a second `wscat` with the agent token receives the live event with `author={kind:"human"}` → agent socket sends a reply → human socket sees it with `author={kind:"agent"}`.
- **Schema violation**: agent POSTs an event whose `type` isn't in the schema → 422 `unknown_event_type`. Payload-shape violation → 422 with Ajv path. `emittedBy` violation (a human posting an agent-only type) → 403 `author_not_allowed`.
- **Idempotency**: two POSTs with the same `idempotency_key` from the same author → second responds 200 with `deduped: true`, same event id.
- **Caps**: artifact over `MAX_ARTIFACT_BYTES` → 413. Event `data` over `MAX_EVENT_DATA_BYTES` → 413. `participants.humans` over `MAX_PARTICIPANTS_PER_SESSION` → 400.
- **State**: posting an event to a closed session → 410. `GET` a session past `expiresAt` → `status: "closed"` even before the sweeper runs.
- **Register**: 404 in `closed` mode (the default); 401 without/with a wrong secret and 201 with the correct bearer secret in `secret` mode; 201 with no auth in `open` mode. In the modes that reach agent creation the returned `api_key` actually authenticates, and a 4th request from one IP within the window → 429.
- **Long-poll**: `GET .../events?wait=5` with a concurrent `POST .../events` returns within ~tens of ms; with nothing happening, returns (empty) within ~5 s.
- **Cursor round-trip**: feeding `next_cursor` back as `since` never re-delivers an event.
- **Callback**: a session with `callback.url` set to a test endpoint; an event matching the filter triggers a signed POST within ~ms; non-matching events don't fire. A failing URL retries twice then stops; the event is still in the log.
- **Identity spoof attempt**: a client tries to set `author` on a POST or WS frame → silently ignored; relay's value wins.
- Tests run against a temp SQLite file (`vitest`, `prisma migrate deploy` into a tmpdir DB, torn down after).
- `npm run typecheck` clean.

## Open decisions

- **Long-poll mechanism**: in-process `EventEmitter` (lean) vs a DB-poll loop. OPEN.
- **`lastUsedAt` write**: every request, fire-and-forget (lean) vs debounced in memory. OPEN.
- **`/v1/register` exposure**: RESOLVED — a tri-state `REGISTRATION_MODE` (`closed` default / `secret` / `open`). `closed` 404s the endpoint so self-hosters are secure by default; `secret` gates it behind a shared bearer secret; `open` is public. A per-IP rate limiter bounds the `secret` and `open` modes.
- **Callback secret storage**: warn-and-allow-unsigned when `CALLBACK_SECRET_KEY` is unset (lean) vs refuse callbacks without it. OPEN.
- **WS broadcast policy**: parallel fire-and-forget (lean) vs serialized awaits. OPEN.
- Dual-auth on the events endpoints, soft-close on DELETE, separate WS handler, Ajv schema validation at the boundary, idempotency via unique constraint: all **DECIDED** above.
