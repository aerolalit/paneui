# Pane: Technical Spec (v1)

Companion to the root `README.md` and `ROADMAP.md` (sibling). Supersedes the v0 sketch.

This spec describes Pane v1: the minimum protocol and implementation needed to ship the OSS core. The shape is locked, the details are open.

> **Vocabulary note.** The live-instance noun is **`pane`** and the reusable
> UI definition is a **`template`** (earlier drafts called these `session` and
> `artifact`; binary content is an `attachment`, formerly `blob`). This spec
> uses the current names throughout; see `docs/NAMING-PROPOSAL.md` for the
> rename history. The word "session" below only ever means a generic
> long-running process (e.g. "an open Claude Code session"), never the Pane
> instance.

## Core idea

The agent generates and ships a UI template, optionally with a per-pane event schema. Humans and agents are peers connected to a single pane. Every interaction (a human click, an agent reply) is an event. State is what you get by replaying events. The relay transports and validates; it does not interpret. A template with no event schema is view-only — a report or dashboard the human only reads.

Three things change vs. v0:

1. Events are the only primitive. No separate `emit` / `submit` verbs. `submit` is one event type; the agent's reply is another, schema-defined.
2. Both sides write to the same UI symmetrically. The agent's reply to a human comment uses the same primitive the human used to post it.
3. The agent declares the pane's event schema up front (or omits it for a view-only template). The relay validates writes against it.

## Stack (unchanged from v0)

TypeScript. Runtime: Node 20+ (Bun fine; keep code runtime-agnostic). Web framework: Hono. ORM: Prisma. SQLite for self-host/default, PostgreSQL for the hosted build (dialect selected at build time via `schema.prisma` provider). MCP server via `@modelcontextprotocol/sdk`. Minimal dependencies.

## Roles

- **Agent**: any process that wants to give a human a rich UI. No public address; only outbound HTTPS or WS calls. Owns the template and the schema for the panes it creates.
- **Relay**: the Pane service. Public URL. Stores panes and events. Serves the shell page that loads the template. Transports and validates events. Self-host (Docker + SQLite) or hosted (Postgres).
- **Human**: opens a URL in any browser; interacts with the template. Multiple humans can share a pane.

## Identity

Every connection authenticates with a token issued by the relay at pane creation. Each token names one identity:

- `human:<id>` (browser; one token per invited human)
- `agent:<id>` (the agent that created the pane)
- `system` (relay-emitted only)

The relay stamps `author` on every accepted event from the auth context. Clients cannot spoof author.

## Event (the only primitive)

Wire shape, identical across both transports:

```json
{
  "id":              "evt_<ulid>",
  "pane_id":        "<id>",
  "author":          { "kind": "human|agent|system", "id": "<id>" },
  "ts":              "2026-05-13T14:30:52.000Z",
  "type":            "<namespace.name>",
  "data":            { "...": "per the pane's schema" },
  "causation_id":    "evt_... or null",
  "idempotency_key": "<optional>"
}
```

Field rules:

- `id`, `ts`, `author` are stamped server-side. The writer omits them.
- `type` must exist in the pane's event schema. 422 otherwise. A view-only pane (no event schema) rejects every `page`/`agent` write `422 unknown_event_type`.
- `data` must validate against the type's payload schema. 422 otherwise.
- `author.kind` must be in the type's `emittedBy`. 403 otherwise.
- `causation_id` is the event id that triggered this one. Optional. Stored verbatim; not validated for existence (it is metadata).
- `idempotency_key` is optional. If `(pane_id, author_id, key)` was seen before, return the existing event id with 200 (not 201).

System events (relay-only; not writable by agent or page):

| Type | Payload |
|---|---|
| `system.participant.joined` | `{ author }` |
| `system.participant.left`   | `{ author }` |
| `system.template.updated`   | `{ version, source_hash }` |
| `system.schema.updated`     | `{ version, added: [type names] }` |
| `system.pane.expired`       | `{}` |

`system.participant.left` is written fire-and-forget when a WebSocket closes,
so a relay crash/restart between connect and close can lose it, leaving an
orphan `joined`. To keep the log self-consistent the relay reconciles on
startup: with zero live connections, every unpaired `joined` on an open pane
is provably stale, so a synthetic `system.participant.left` is emitted for each
surplus `joined` (paired per `author`). Presence counts (`agentCountLive`) are
tracked from connection lifecycle, never derived from this log.

## Per-pane event schema

The agent ships this at pane creation — or omits it. Shape:

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
- No global event registry. Each pane owns its vocabulary. An agent that wants stable cross-pane types simply ships the same schema each time.
- Schema can be PATCHed mid-pane (additive only). The relay emits `system.schema.updated`.
- The relay uses Ajv to validate `data` against the type's `payload`.
- **The event schema is optional.** A template that omits it is **view-only**: a report, dashboard, or chart the human only reads. The pane declares an empty, strictly-enforced event vocabulary — every `page`/`agent` emit is rejected `422 unknown_event_type`. System events still flow, and a view-only template may still carry an `input_schema` (a reusable report template seeded per pane with `input_data`).

> **Standards-aligned event schema (`x-pane-events`).** New templates should
> prefer the standards-aligned shape — a JSON Schema 2020-12 document with one
> namespaced extension (`x-pane-events`), mirroring the `x-pane-collections`
> convention used for records below. The legacy `events`/`payload`/`emittedBy`
> shape above stays supported; both normalize to the same internal
> representation. The relay rejects a document that mixes both. See
> `skills/pane/SKILL.md` for the side-by-side mapping.

## Template

The HTML/JS the agent generated, served to the pane. v1 formats:

| Type | Source |
|---|---|
| `html-inline` | A single string of HTML/CSS/JS, capped 2 MB. Served as-is. |
| `html-ref`    | An opaque URL the agent uploaded elsewhere; relay fetches and caches. (Reserved in the schema; the relay does not serve `html-ref` in this release — pass HTML inline.) |

Same sandbox rules apply to both. Not in v1: React bundles, runtime compilers, server-rendered frameworks.

Editing a template appends a new immutable version (`POST /v1/templates/{id}/versions`); the relay emits `system.template.updated` on panes upgraded to it. The shell page reloads the iframe. The event log is preserved across reloads.

## Sandbox

The template is treated as hostile by default (LLM-generated). The relay enforces:

- Iframe `sandbox="allow-scripts"` (plus `allow-forms` for Enter-to-submit; there is no `allow-same-origin`, so a form's native submission still can't reach any origin). No `allow-top-navigation`.
- CSP on `/s/{token}/content`: `default-src 'self'; script-src 'unsafe-inline'; connect-src 'none'; img-src data: blob: 'self'; style-src 'unsafe-inline' 'self'`.
- No external network. The template's only escape is `postMessage` to the shell page.
- `frame-ancestors` on relay's own pages.
- HTML served only through the relay endpoint (never a raw URL with bypassable headers).
- HTML size cap (2 MB); event `data` cap (64 KB).

## Bridge

The shell page (outside the iframe) holds the WebSocket and the token. The pane runtime, served alongside the shell, exposes `pane` to the template via `postMessage`:

```ts
pane.emit(type, data, opts?): Promise<{ id }>
pane.on(type, handler): unsubscribe
pane.state: ReadonlyEventLog
pane.records: { snapshot(name), on(name, handler), create/upsert/update/delete(...) }
pane.inputData: unknown            // this pane's per-instance seed data
pane.ready: Promise<void>          // resolves once init (inputData + replay) lands
```

`opts.causationId` tags the parent event. `opts.idempotencyKey` makes the write retry-safe. (The runtime also exposes `uploadBlob` / `downloadBlob` / `saveBlob` for attachments — these keep the legacy `Blob` suffix for runtime compatibility; everything else uses "attachment".)

The shell page:

1. Opens a WS to the relay using the human's token.
2. Replays events into local state on connect.
3. Forwards new events to the iframe via `postMessage` (filtered to public types).
4. Receives `pane.emit` calls from the iframe via `postMessage`, validates origin, forwards to WS.

The template never sees the token.

## Transports

Two, interchangeable, same event shape.

### WebSocket (primary)

```
WS /v1/panes/{id}/stream
Auth: ?ticket=<ws_ticket>  (browser path, preferred)
  or  Authorization: Bearer <token> / ?token=<token>  (non-browser clients)

on open  → server replays event log from cursor=0
server → { id, pane_id, author, ts, type, data, causation_id, idempotency_key }
client → { type, data, causation_id?, idempotency_key? }
```

Browsers cannot set an `Authorization` header on `new WebSocket()`, so the WS
URL must carry the credential as a query parameter. A long-lived token there
leaks into upstream reverse-proxy access logs. The browser path therefore uses
a **short-lived ticket**: the client first calls `POST /v1/panes/{id}/ws-ticket`
(authenticated with the real token), receives a single-use ticket with a 30s
TTL bound to that (identity, pane), then opens the WebSocket with
`?ticket=<ticket>`. The ticket is consumed on upgrade. Non-browser clients
(e.g. the agent CLI) may still pass the real token via `Authorization` or
`?token=` directly.

**Self-echo before ack.** When a WS client emits a frame, the relay inserts and
broadcasts the event *before* sending the ack back to the emitter. The sender
therefore receives its own event echoed on the same connection, and that echo
arrives ahead of the ack for the emit. Clients that both send and receive on one
connection — multiplexed agents, the page runtime — must dedupe by event id
(`event.id` vs the `id` returned in the ack).

**Slow-client backpressure (v1 limitation).** The relay broadcasts synchronously
to every subscribed socket; each subscriber gets a plain `ws.send()`. v1 has no
backpressure: large pane event rates against slow connections may grow the
per-socket send buffer unbounded, since the `ws` library queues data internally
when a socket is not draining. The v2 fix is a per-socket `bufferedAmount`
threshold — when a socket exceeds it, `terminate()` that one slow client (drop
the offending connection only, not the whole pane).

### HTTP POST + cursor read (stateless fallback)

```
POST /v1/panes/{id}/events
  Authorization: Bearer <token>
  Body: { type, data, causation_id?, idempotency_key? }
  → 201 { event: ... }

GET /v1/panes/{id}/events?since=<cursor>&wait=<seconds>
  Authorization: Bearer <token>
  → 200 { events: [...], cursor: <opaque> }
```

A stateless agent reads via `?wait=30` (long-poll) or callback. A long-running agent (a claw, an open Claude Code session) holds a WS.

## Callbacks (optional)

Agents that cannot poll or hold a WS register a webhook at pane creation:

```json
"callback": {
  "url":     "https://my-agent/pane",
  "events":  ["review.*", "approval.*"],
  "secret":  "<HMAC shared secret>"
}
```

The relay POSTs `{ pane_id, event }` for each matching event. Signed `X-Pane-Signature: sha256=<hmac of timestamp.body>`. Retries 3x with exponential backoff. Durable delivery (dead-letter, replay) is a hosted feature.

## HTTP API (v1)

All agent endpoints require `Authorization: Bearer <api_key>` from `agents`.

| Method | Path | Description |
|---|---|---|
| `POST`   | `/v1/register` | Self-provision an API key. Gated by `REGISTRATION_MODE`: `closed` (default) → 404; `secret` → requires a bearer registration secret; `open` → public, per-IP rate-limited. |
| `POST`   | `/v1/templates` | Create a named, reusable template + its v1 content. |
| `POST`   | `/v1/templates/{id}/versions` | Append a new immutable version (content only). |
| `PATCH`  | `/v1/templates/{id}` | Update head metadata (`name`, `slug`, `description`, `tags`). Never the content. |
| `GET`    | `/v1/templates?q=<query>` | Search/list the agent's named templates. Lean response (no `source`); ranked by `last_used_at`. |
| `GET`    | `/v1/templates/{id}` | Get a template + its version list. `{id}` accepts the template id or its slug. |
| `GET`    | `/v1/templates/{id}/versions/{version}` | Get one version's full content. |
| `POST`   | `/v1/panes` | Create a pane — one use of a template version (see below). |
| `GET`    | `/v1/panes` | List the caller's panes. Filters: `status` (open\|closed\|all, default open), `limit` (≤200), `cursor`, `template_id`. Lean — carries `active_human_participants` (count) but NOT the full participant array. NO secrets — no token plaintext, no callback URL, no metadata / input_data. |
| `GET`    | `/v1/panes/{id}` | Pane metadata. |
| `GET`    | `/v1/panes/{id}/participants` | List every participant on one pane (active and revoked). Bounded by `MAX_PARTICIPANTS_PER_PANE`; no pagination. Used to find `participant_id` for revoke. |
| `POST`   | `/v1/panes/{id}/participants` | Mint a fresh human participant URL on an existing pane. One-shot token in the 201 body. 410 on a closed/expired pane; 409 at the active-human cap (revoked rows excluded). |
| `DELETE` | `/v1/panes/{id}/participants/{participant_id}` | Revoke one participant URL (idempotent). 400 if targeting the agent participant — use `DELETE /v1/panes/{id}` instead. |
| `PATCH`  | `/v1/panes/{id}/schema`   | Additive schema update. |
| `POST`   | `/v1/panes/{id}/upgrade`  | Re-pin the pane to a newer template version. |
| `DELETE` | `/v1/panes/{id}` | Close the pane. |
| `POST`   | `/v1/panes/{id}/events` | Write one event. |
| `GET`    | `/v1/panes/{id}/events?since=<cur>&wait=<s>` | Read events. Long-poll. |
| `GET/POST/PATCH/DELETE` | `/v1/panes/{id}/records/{collection}` | Per-pane record collections (see **Records**). |
| `POST`   | `/v1/panes/{id}/ws-ticket` | Mint a short-lived (30s), single-use WebSocket upgrade ticket. |
| `WS`     | `/v1/panes/{id}/stream` | Bidirectional event (and record) stream. |
| `GET`    | `/v1/keys` | List the calling agent's keys. |
| `DELETE` | `/v1/keys/{id}` | Revoke. |

Human-facing (no agent auth; URL token IS the auth):

| Method | Path | Description |
|---|---|---|
| `GET` | `/s/{human_token}`         | Shell page. Loads bridge + iframe. |
| `GET` | `/s/{human_token}/content` | Streams the template under sandbox CSP. |

A logged-in human who owns the pane is 302'd from `/s/{token}` to a clean, token-free `/panes/{id}` owner shell (cookie-authed). Agents need not detect this — the `/s/{token}` URL you hand off still works.

### Templates and panes

A **template** is a reusable, versioned UI definition owned by an agent: HTML +
an event schema + an optional `input_schema` (+ an optional `record_schema`). A
**template version** is the immutable content of one revision. A **pane** is one
*use* of one version of a template, in one context. Many panes reference one
template version.

Editing a template never mutates an existing version — it appends a new
`template_version` row and advances `templates.latest_version`. A pane pins
the version it was created with, so panes running on an old version are
unaffected by later edits.

`/v1/templates` is scoped to the calling agent: an agent sees and uses only its
own templates. Referencing another agent's template id is a `404`.

### `POST /v1/panes` request

The `template` field takes **one of two forms** — exactly one of `template.id`
/ `template.source` must be present:

```jsonc
// Form 1 — reference: instance an existing named template (the reuse path).
{
  "template":   { "id": "tpl_abc", "version": 3 },  // version optional → latest
  "input_data": { "prTitle": "..." },               // optional, see below
  "participants": { "humans": 1 },
  "ttl":          3600,
  "metadata":     { "label": "PR #42 review" },
  "callback":     { "url": "...", "events": ["..."], "secret": "..." }
}

// Form 2 — inline: a one-off template defined on this call. The relay
// transparently creates a named template behind it, owned by the calling
// agent, and the pane pins its single version. `name` is REQUIRED (so the
// owner UI shows a readable label, and the title can fall back to it);
// `slug` is optional and must be unique among the agent's templates.
{
  "template": {
    "name":         "PR review",
    "slug":         "pr-review",        // optional
    "type":         "html-inline",
    "source":       "<...html...>",
    "event_schema": {
      "events": {
        "review.commentAdded": {
          "payload":   { "...": "JSON Schema" },
          "emittedBy": ["page", "agent"]
        }
      }
    },
    "input_schema": { "...": "JSON Schema for input_data — optional" }
  },
  "input_data": { "...": "..." }
}
```

`input_data` is this instance's per-render seed data. When given, the relay
validates it against the pinned version's `input_schema` at create time (a
clear error on mismatch, exactly like a rejected event). It is distinct from
`metadata`, which the relay never reads or validates. The page reads
`input_data` via the `window.pane.inputData` bridge field.

`template.input_schema` on the **inline form** is optional. Pass it when
`input_data` carries `attachment_id`s the page needs to render: the participant
attachment-download bridge walks `input_data` against the version's `inputSchema`
for `"format": "pane-attachment-id"` sites, and an attachment without a walkable
site is unreachable from the page even when the agent owns it. The reference form
has no equivalent flag because the schema lives on the template version
already.

Either form, the pane ends up FK'd to a `template_version` — there is no
nullable-FK branch. The inline form is sugar over the same model, not a
parallel code path.

`participants.humans` is a count; the relay issues that many human tokens. The agent that created the pane is implicitly the only agent participant. Multi-agent panes are v2.

### `POST /v1/panes` response

```json
{
  "pane_id": "pan_...",
  "tokens": {
    "humans": ["tok_h_..."],
    "agent":  "tok_a_..."
  },
  "urls": {
    "humans":       ["https://pane.relay/s/tok_h_..."],
    "agent_stream": "wss://pane.relay/v1/panes/pan_.../stream"
  },
  "expires_at": "2026-05-13T..."
}
```

Deliver `urls.humans[0]` to the human; keep `pane_id`.

## Data model (v1)

```
agents 1 ──< templates 1 ──< template_versions 1 ──< panes 1 ──< events
                                                          1 ──< participants
                                                          1 ──< record_collections 1 ──< pane_records
```

> **Records (#287)** — a third first-class data shape was added after v1's
> initial release. `record_collections` and `pane_records` back per-pane
> mutable record collections (posts, comments, reactions, etc.) declared via
> a JSON Schema 2020-12 document on `template_versions.record_schema`. Wire
> shapes, routes, and config knobs are summarised in the **Records** section
> below; the canonical design is in epic
> [#287](https://github.com/aerolalit/paneui/issues/287). The legacy event
> log is unchanged — records are additive.

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
| `rate_limit`    | nullable int. Per-agent panes-per-hour cap. |

### `templates` (the head — mutable identity, no content)

| column | notes |
|---|---|
| `id`             | cuid. FK target. |
| `owner_id`       | FK → `agents`. The owning agent. |
| `name`          | required (NOT NULL). Both the reference and inline create forms supply it, so the owner-shell UI always has a readable label. The `require_template_name` migration backfilled any pre-existing anonymous (inline-created) rows to "Untitled template" before adding the constraint. |
| `slug`          | nullable. Agent-chosen stable handle; unique per owner; `null` when the creator didn't supply one. |
| `description`   | nullable. Prose: what the template is and does. |
| `tags`          | nullable JSON string array. Keywords for search. |
| `latest_version`| int. Newest version number. |
| `last_used_at`  | nullable. Bumped when a pane is created; ranks search results. |
| `created_at`    | |
| `updated_at`    | |

### `template_versions` (the child — immutable per-version content)

| column | notes |
|---|---|
| `id`             | cuid. FK target. |
| `template_id`    | FK → `templates`, `ON DELETE CASCADE`. |
| `version`        | int. 1, 2, 3, …; unique per `(template_id, version)`. |
| `template_type`  | `html-inline` or `html-ref`. |
| `template_source`| TEXT (inline) or URL (ref); capped 2 MB. |
| `event_schema`   | JSON, nullable. The event vocabulary for panes on this version. `null` = a view-only version (no event vocabulary). |
| `input_schema`   | nullable JSON Schema. Shape of `panes.input_data`. |
| `record_schema`  | nullable JSON Schema 2020-12 (`x-pane-collections`). Declares record collections — see **Records**. |
| `created_at`     | |

### `panes`

A pane is one use of one `template_version`.

| column | notes |
|---|---|
| `id`                   | cuid (`pan_…` prefix). |
| `agent_id`             | FK → `agents`. |
| `template_version_id`  | FK → `template_versions`. The pinned version this pane instantiates. |
| `input_data`           | nullable JSON. This instance's render data; validated against the version's `input_schema` at create time. |
| `status`               | `open` or `closed`. |
| `created_at`           | |
| `expires_at`           | |
| `metadata`             | JSON. Arbitrary agent bookkeeping the relay never reads. |
| `callback_url`         | nullable. |
| `callback_secret_hash` | nullable. |
| `callback_filter`      | nullable. |

The template content columns (`template_type`, `template_source`, `event_schema`) live on `template_versions`; the obsolete per-pane `template_version` / `schema_version` counters were dropped in favour of real template versioning + the version pin.

### `participants` (one row per identity that may connect)

| column | notes |
|---|---|
| `id`             | cuid. |
| `pane_id`        | FK → `panes`. |
| `kind`           | `human` or `agent`. |
| `identity_id`    | the value in `author.id`. |
| `token_hash`     | sha256 of the auth token. |
| `token_prefix`   | display only. |
| `joined_at`      | nullable; stamped on the first **WebSocket** connect only. HTTP polling of `GET /v1/panes/:id/events` does not count as joining. |
| `revoked_at`     | nullable. |

### `events`

| column | notes |
|---|---|
| `id`              | BIGINT autoincrement. Doubles as the poll cursor (API exposes it as opaque). |
| `pane_id`         | FK → `panes`, ON DELETE CASCADE. |
| `author_kind`     | `human` / `agent` / `system`. |
| `author_id`       | participant identity. |
| `type`            | text. |
| `data`            | JSON. |
| `causation_id`    | nullable; not constrained (metadata only). |
| `idempotency_key` | nullable. |
| `ts`              | timestamp. |
| Unique            | `(pane_id, author_id, idempotency_key)` where `idempotency_key NOT NULL`. |
| Index             | `(pane_id, id)` for cursor reads. |

TTL cleanup: hourly `DELETE FROM panes WHERE expires_at < now()`. Cascades to `events` and `participants`.

(Hosted-only later, in `/ee/`: `orgs`, `projects`, scoped api_keys, quotas, audit log.)

## Validation flow

Every write (POST or WS message) runs:

1. Decode token; resolve `participant`. 401 if invalid or revoked.
2. Check `pane.status == 'open'`. 410 otherwise.
3. Lookup `type` in the pane's `event_schema`. 422 if missing. A view-only pane (`event_schema` is `null`) has no vocabulary — every `page`/`agent` write is rejected `422 unknown_event_type`.
4. Check `participant.kind ∈ type.emittedBy`. 403 if not.
5. Validate `data` against the type's `payload` schema (Ajv). 422 with the failed path on error.
6. Idempotency check: if `(pane_id, author_id, idempotency_key)` exists, return that event_id with status 200. Else proceed.
7. Insert event row; stamp `id`, `ts`, `author` server-side.
8. Broadcast to every participant WS socket in the pane.
9. Fire callback if `callback_filter` matches.

## Auth (three layers; only #1 and #2 in v1)

1. **Agent → relay**: bearer token in the `agents` table. Issued via `POST /v1/register`, whose exposure is operator-configurable through `REGISTRATION_MODE`: `closed` by default (endpoint 404s — keys come from `API_KEY` / auto-mint), `secret` (bearer registration secret required), or `open` (public, per-IP rate-limited). `sha256(key) + prefix` stored. Bump `last_used_at` on each request. Revocable via `DELETE /v1/keys/{id}`.
2. **Participant → pane**: per-identity token issued at `POST /v1/panes` time. Stored as `sha256(token)` in `participants.token_hash`. URL token IS the auth for humans.
3. **Multi-tenancy / roles / orgs / SSO**: hosted only, v2+. (A first-class human identity — magic-link login, owner shell, claimed agents — has since landed for the hosted relay; see `skills/pane/SKILL.md`.)

## Security checklist

- Iframe `sandbox="allow-scripts"` (+ `allow-forms`). No `allow-same-origin` (cookies + parent DOM remain unreachable).
- CSP `connect-src 'none'` on `/s/{token}/content`: the template has no external network.
- `frame-ancestors` on relay's own pages.
- HTML served only through the relay endpoint.
- HTML size cap (2 MB); event data cap (64 KB).
- Per-agent pane-create rate limit.
- Token entropy 128 bits, base32 encoded.
- Webhook signatures HMAC-SHA256 over `timestamp.body`, 5-minute replay window.
- `postMessage` origin check on the shell-iframe boundary.
- Schema validation rejects writes outside the declared vocabulary, so LLM-generated templates cannot exfiltrate via custom event types.

## Open/closed line (open-core)

Principle: the OSS version must do the whole job, end to end, for one user, on their own server, forever, no asterisks. Never cap volume on self-host. Never phone home. The bridge protocol stays fully open.

**OSS (MIT, default build):**

- Single-container relay (Docker + SQLite).
- All transports: WS, HTTP POST + long-poll, best-effort signed webhook.
- Schema validation, identity stamping, sandbox.
- Bearer auth, key issuance, revocation, `POST /v1/register` gated by `REGISTRATION_MODE` (closed default / secret / open) with per-IP rate limiting in the secret and open modes.
- MCP server wrapping `create_pane(template, schema)` and `await_pane_result(pane_id, terminal_event_type)`.
- Reference demo: a `claudeclaw` integration that lets the agent ask Lalit something through a UI.

**Hosted / `/ee/`:**

- Console: browse panes, replay timelines, analytics (open rate, time-to-answer, completion rate), search.
- Orgs, projects, scoped api_keys, usage quotas, billing.
- Participant access control: SSO, magic-link, "only user X can open this".
- Robust webhook delivery: dead-letter queue, replay, configurable retry. Signing is already in OSS.
- Higher limits, SLA, SOC2, EU data residency, support.

## Records (#287)

Per-pane mutable record collections. Third first-class data shape alongside events and attachments. Use records when the **current value** of structured rows is what matters and the history isn't; keep events for the **journal of interactions** (audit trail, activity feed).

### Decision rule

| Use a **record** when… | Use an **event** when… |
|---|---|
| Current value is what matters; history isn't | History is the point (audit, replay) |
| Multiple participants edit different rows concurrently | Writers serialise naturally and order matters |
| Hundreds-to-thousands of items in the collection | Dozens of writes total per pane |
| Partial-row mutations, paginated reads | Immutable facts, stream reads |

### Schema declaration — JSON Schema 2020-12 + `x-pane-collections`

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
$defs:
  Comment:
    type: object
    properties: { body: { type: string, maxLength: 4000 } }
    required: [body]
x-pane-collections:
  comments:
    schema: { $ref: "#/$defs/Comment" }
    write:  [page]              # subset of {agent, page}
    delete: [author]            # subset of {agent, page, author}
```

Set on the template via `record_schema` at create / version time. Validated by `validateRecordSchemaShape` in `core/validation.ts`. Standards-first: only `x-pane-collections` is pane-specific; the rest is plain JSON Schema.

### HTTP routes

```http
GET    /v1/panes/:id/records/:collection?since=&limit=
POST   /v1/panes/:id/records/:collection
PATCH  /v1/panes/:id/records/:collection/:recordKey
DELETE /v1/panes/:id/records/:collection/:recordKey
```

`dualAuth` (agent owner or participant token). POST is **create-or-return-existing** (duplicate `record_key` → 200 with `deduped: true`, no version bump). PATCH and DELETE accept `if_match: <version>`; on mismatch return **409** with the current row in `error.details.current`. GET pagination via `?since=<seq>` includes tombstones.

### WebSocket messages

Records flow over the same `/v1/panes/:id/stream` channel as events. The wire shapes (defined in `ws/messages.ts`) are discriminated by the top-level `kind` field — events have no `kind`, every other shape does:

```json
{ "kind": "record.upsert",          "collection": "comments", "record": { ... } }
{ "kind": "record.delete",          "collection": "comments", "record": { "id","key","seq","deleted_at" } }
{ "kind": "record.replay.complete", "collection": "comments", "seq": 17 }
```

Subscribe with `?subscribe_records=*` (all declared collections) or `?subscribe_records=a,b` (filter). Per-collection reconnect cursors via `?since_record_seq.<name>=<seq>`. The bridge shell auto-subscribes to all collections; the page-side `pane.records.snapshot(name)` / `pane.records.on(name, h)` API consumes the deltas.

### Config knobs

| Var | Default | Notes |
|---|---|---|
| `MAX_RECORDS_PER_COLLECTION` | 50000 | Live-row ceiling. 0 disables. Tombstones excluded. |
| `MAX_RECORD_DATA_BYTES` | 65536 | Per-row payload byte cap. |
| `MAX_RECORDS_PER_PAGE` | 200 | GET pagination cap. |
| `RECORD_TOMBSTONE_TTL_SECONDS` | 604800 (7d) | Soft-deleted rows hard-deleted after this. Floor 60s. |
| `RECORD_SWEEPER_INTERVAL_SECONDS` | 3600 (1h) | Tombstone sweeper interval. 0 disables. |

### Authz model

| Step | Rule |
|---|---|
| 1 | Token resolves to an `Author` and `Pane` (`dualAuth`) |
| 2 | `pane.status === "open" && expiresAt > now` |
| 3 | `author.kind` (mapped to `agent` / `page`) ∈ `write` / `delete` |
| 4 | `delete: ["author"]` → `row.authorId === author.id` |
| 5 | Attachment refs scoped to `pane.agentId` (mirrors event-write) |

### Out of scope (open questions)

- Server-side data migration of records on incompatible upgrade.
- A `?filter=` grammar on the list route.

**Code-sharing:** one repo, MIT/Apache core, `/ee/` directory under a commercial license. Default build excludes `/ee/`. License-key gate only for enterprise features that run in self-host. Clean seams (auth, storage, event delivery) so `/ee/` plugs in without monkey-patches.

**License:** MIT or Apache on the core. Hosted-only code in a private repo. Skip BSL.

---

That's v1. Ship the OSS core in a weekend, dogfood in a claw, hosted-lite demo on Azure credits.
