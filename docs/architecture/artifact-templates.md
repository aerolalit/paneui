# Reusable Artifacts (design note)

Status: **ACCEPTED** — design of record; implementation in progress (phases
A–D). The hosted relay has no users yet, so the schema change is a clean
database reset — no migration or backfill.

## Summary

Today an artifact is a property *of* a session: the HTML, its event schema, and
its type live as inline columns on `sessions`. Every `POST /v1/sessions`
carries the full artifact. An agent that runs the *same* UI repeatedly — a PR
review page, an approval form, a survey — re-sends (and, for an LLM agent, often
re-generates) that HTML on every call.

This note proposes inverting the relationship: an **artifact** becomes a
first-class, versioned, reusable entity owned by an agent, and a **session**
becomes one *instance* — one *use* — of an artifact in one context. Many
sessions reference one artifact. The agent authors the HTML once; each new use
is a small `{ artifact_id, version, input_data }` call.

**Out of scope:** global / cross-agent *published* templates (a public registry,
discovery, cross-tenant visibility). That is a larger, multi-tenant feature with
its own abuse surface — deliberately deferred. This note covers only an agent's
**own** reusable artifacts. The versioning model here is, however, the same
machinery a future publish feature would need, so it does not have to be redone.

## Motivation

- **Token cost.** An LLM agent generating artifact HTML pays for it on every
  session. Authoring once and instancing thereafter removes that repeated cost.
- **Consistency.** Ten PR reviews driven by ten separately-generated copies of
  "the same" page will drift. One artifact, ten sessions, do not.
- **A cleaner model.** A session genuinely *is* an instance: it already owns its
  own events, participants, and TTL. The artifact is the reusable part. The
  schema should say so.

## The model

```
artifacts ──1───∞── artifact_versions ──1───∞── sessions
   │                      │                        │
 identity            content per version      one use / context
 ownership           (HTML, schemas)          input_data + events
```

- **artifact** — stable identity: who owns it, its name. Carries no content.
- **artifact_version** — the content, immutable once created: the HTML, the
  event schema, the input schema. Editing an artifact appends a new version
  row; existing versions are never mutated.
- **session** — one use of one *version* of an artifact, in one context. Pins
  `(artifact_id, version)`. Holds this instance's `input_data` and its events.

### Why two tables, not one (Option B)

A single `artifacts` table keyed on `(artifact_id, version)` would also work
(every version a full row). This note chooses the **head + version-child**
split:

- `artifacts` (the head) holds what is true across all versions — owner, name,
  the "current" version pointer. Mutable identity.
- `artifact_versions` (the child) holds per-version content. Append-only;
  rows are immutable once written.

The split keeps the mutable identity (rename an artifact, repoint "latest")
separate from the immutable content history, makes "list an agent's artifacts"
a query over the small head table, and gives a session a single clean FK
target (`artifact_versions`) — the row it pins is, by construction, frozen.

## Data model

New tables (Prisma sketch; SQLite + Postgres both):

```prisma
model Artifact {
  id            String   @id @default(cuid())
  ownerId       String   @map("owner_id")          // -> agents.id
  owner         Agent    @relation(fields: [ownerId], references: [id])
  // null = an anonymous artifact, created transparently for an inline
  // (one-off) session — see "Inline artifacts are sugar" below. A named
  // artifact is one the agent registered for reuse.
  name          String?
  latestVersion Int      @default(1) @map("latest_version")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")
  versions      ArtifactVersion[]

  @@index([ownerId])
  @@map("artifacts")
}

model ArtifactVersion {
  id             String   @id @default(cuid())
  artifactId     String   @map("artifact_id")
  artifact       Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  version        Int                                         // 1, 2, 3, ...
  artifactType   String   @map("artifact_type")              // html-inline | html-ref
  artifactSource String   @map("artifact_source")            // the HTML for THIS version
  eventSchema    Json     @map("event_schema")               // event vocabulary
  inputSchema    Json?    @map("input_schema")               // shape of session.input_data
  createdAt      DateTime @default(now()) @map("created_at")
  sessions       Session[]

  @@unique([artifactId, version])
  @@index([artifactId])
  @@map("artifact_versions")
}
```

`Session` gains a reference to the pinned version and a typed instance-data
column, and **loses** its inline artifact columns:

```prisma
model Session {
  id                 String           @id
  agentId            String           @map("agent_id")
  // ...

  // The pinned artifact version this session instantiates.
  artifactVersionId  String           @map("artifact_version_id")
  artifactVersion    ArtifactVersion  @relation(fields: [artifactVersionId], references: [id])

  // This instance's data — validated against the version's input_schema at
  // create time. Distinct from `metadata` (see below).
  inputData          Json?            @map("input_data")

  // REMOVED: artifact_type, artifact_source, event_schema, artifact_version,
  //          schema_version  — all now live on artifact_versions.
  // KEPT: metadata (arbitrary agent bookkeeping the relay never reads),
  //       callback_*, status, expiresAt, participants, events.
  // ...
}
```

### `input_data` vs `metadata` — two different things

`sessions.metadata` exists today and **stays as-is**: arbitrary agent
bookkeeping the relay does not read, validate, or render.

`input_data` is new and different: it is the **per-instance render data** the
artifact needs — the "PR metadata" (title, diff URL, file list) that makes the
same PR-review page show *this* PR. It is a typed input contract, validated by
the relay. Conflating the two would mix "data the relay enforces and the
artifact renders" with "data the relay ignores" — so it gets its own column.

## Concrete schema delta

The exact tables and columns added, changed, and removed.

**NEW table — `artifacts`** (the head: mutable identity, no content)

| Column | Type | Notes |
|--------|------|-------|
| `id` | String, PK | `cuid()` |
| `owner_id` | String, FK → `agents.id` | the owning agent |
| `name` | String, **nullable** | `null` = anonymous (inline-created); set = a named reusable artifact |
| `slug` | String, **nullable** | agent-chosen stable handle (`pr-review`); unique per owner; `null` for anonymous |
| `description` | String, **nullable** | prose: what the artifact is and does — read by an agent deciding whether to reuse it |
| `tags` | Json (string array), **nullable** | keywords for search (`["review","pr","code"]`) |
| `latest_version` | Int, default 1 | newest version number |
| `last_used_at` | DateTime, **nullable** | bumped when a session is created from the artifact — ranks search results |
| `created_at` | DateTime | default `now()` |
| `updated_at` | DateTime | `@updatedAt` |

Index: `owner_id`. Unique: `(owner_id, slug)` — a slug is unique within an
owner; anonymous artifacts have `slug = null` and are exempt.

**NEW table — `artifact_versions`** (the child: immutable per-version content)

| Column | Type | Notes |
|--------|------|-------|
| `id` | String, PK | `cuid()` |
| `artifact_id` | String, FK → `artifacts.id` | `ON DELETE CASCADE` |
| `version` | Int | 1, 2, 3, … |
| `artifact_type` | String | `html-inline` / `html-ref` — **moved from `sessions`** |
| `artifact_source` | String | the HTML — **moved from `sessions`** |
| `event_schema` | Json | event vocabulary — **moved from `sessions`** |
| `input_schema` | Json, nullable | **NEW** — JSON Schema for `session.input_data` |
| `created_at` | DateTime | default `now()` |

Unique: `(artifact_id, version)`. Index: `artifact_id`.

**CHANGED table — `sessions`**

Columns ADDED (2):

| Column | Type | Notes |
|--------|------|-------|
| `artifact_version_id` | String, FK → `artifact_versions.id` | the pinned version this session instantiates — the version pin |
| `input_data` | Json, nullable | this instance's data; validated against the version's `input_schema` |

Columns REMOVED (5) — all move to `artifact_versions` or become obsolete:

| Removed | Fate |
|---------|------|
| `artifact_type` | → `artifact_versions.artifact_type` |
| `artifact_source` | → `artifact_versions.artifact_source` |
| `event_schema` | → `artifact_versions.event_schema` |
| `artifact_version` | dropped — was a per-session edit counter; replaced by real artifact versioning + the pin |
| `schema_version` | dropped — same: an obsolete per-session counter |

Columns UNCHANGED (8): `id`, `agent_id`, `status`, `created_at`, `expires_at`,
`metadata`, `callback_url`, `callback_secret_enc`, `callback_filter`.

**`agents`** — gains only a Prisma back-relation (`artifacts Artifact[]`); no
column change. **`events`**, **`participants`** — unchanged.

## Inline artifacts are sugar — one model, two entry points

A session is **always** an instance of an `artifact_version`. There is no
"artifactless session" and no nullable artifact FK. But an agent must not be
forced to register an artifact for a throwaway, one-off UI — that would tax the
common case.

So `POST /v1/sessions` accepts the artifact in either of two forms, and the
*inline* form is sugar over the same model:

- **By reference** — `artifact: { id, version? }` — instances an existing
  (named) artifact. The reuse path; cheap, no HTML re-sent.
- **Inline** — `artifact: { source, type, event_schema }` — for a one-off UI.
  The relay **transparently creates an anonymous artifact** (`name = null`)
  with a single version, owned by the calling agent, and the session pins it.
  The agent does not see or manage that artifact; it is an implementation
  detail.

Result: one mental model ("a session instances an artifact version" — always
true, no special case in the schema), **and** zero ceremony for one-offs
(`pane create --artifact ./form.html` stays a single call). An agent that later
wants to reuse a one-off can **name** its anonymous artifact (promote it) with
no re-upload.

This is why the inline path is kept — dropping it would make every throwaway UI
a two-step (`create artifact` → `create session`) ceremony, friction the agent
feels on every call. Keeping it as *sugar* (not a parallel code path) preserves
the single model.

## Discovery — making artifacts *actually* reusable

A reusable artifact is only reusable if the agent can **find it again**. The
artifact lives on the relay (durable); the agent does not — a fresh Claude Code
(or other) session starts with no memory of `art_abc`. Storage alone does not
make a thing reusable; **rediscovery** does. This is both an API problem and a
prompt problem.

**Self-describing metadata.** A named artifact carries enough for an agent to
recognise it without opening the HTML:

- `name` / `slug` — a short handle (`pr-review`).
- `description` — prose: *what it is and does* ("PR review page: shows the
  diff, lets a reviewer approve / request changes with inline comments").
- `tags` — keywords for search.
- `input_schema` — doubles as documentation: it tells the agent exactly what
  data the artifact needs (`{prTitle, diffUrl, files[]}`), so a found artifact
  is immediately usable.

**Search, not just list.** `GET /v1/artifacts?q=...` does a text search over
name + description + tags, ranked by `last_used_at` (what the agent actually
uses outranks abandoned experiments). The list/search response is **lean** —
`id, slug, name, description, tags, latest_version, last_used_at` — and
deliberately omits `artifact_source`: an agent browsing 30 artifacts does not
want 30 HTML blobs; it fetches a full version only once it has chosen one.

**The stable handle.** A `cuid()` is unguessable and unmemorable — an agent
cannot carry it across sessions. The agent-chosen `slug` is the durable handle:
an agent (or its operator) can record `pr-review` in its own prompt/notes and
later `pane create --artifact-id pr-review` with no search at all. Search is
the fallback when the agent does *not* already know the slug.

**The behavioural half — the skill must say "look first".** A search endpoint
is dead weight if the agent never calls it. The pane skill (`SKILL.md`) must
instruct: *before generating artifact HTML, run `pane artifact search` / `list`
— a reusable artifact may already exist; reuse it instead of regenerating.*
Without that instruction every fresh session regenerates from scratch and the
whole feature is unused. This is the single most load-bearing piece of making
reuse real, and it is a phase-D deliverable, not an afterthought.

## The two schemas an artifact version declares

An artifact version is a typed component. It declares **both** of its
contracts, both as JSON Schema (the same mechanism `event_schema.payload`
already uses — `ajv` is already a relay dependency):

| Field | Defines | Relay validates |
|-------|---------|-----------------|
| `event_schema` | the event vocabulary — what page/agent may *emit* | every event (as today) |
| `input_schema` | the instance data the artifact needs to render | `session.input_data`, at session-create time |

So a session-create against an artifact fails fast — with a clear error,
exactly like a rejected event — if its `input_data` does not satisfy the
version's `input_schema`. `input_schema` is optional: an artifact that needs no
seed data omits it.

## Versioning and the breaking-change rule

Editing an artifact **never mutates an existing version**. It appends a new
`artifact_version` row (`version = latest + 1`) and advances
`Artifact.latestVersion`.

A session **pins the version it was created with** (`artifact_version_id`).
Therefore:

- A breaking change — most often `input_schema` gaining a required field, or
  the HTML changing shape — produces a *new version*. Sessions already running
  on the old version are unaffected: they render the old HTML and validate
  against the old `input_schema`.
- New sessions target a version explicitly, or default to
  `Artifact.latestVersion`.

This is the same version-pinning guarantee the deferred global-template idea
needs; building it here means it is not redone later.

**Note — the contract surface.** `input_schema` is a breaking-change surface:
the moment a new version requires a new field, every caller creating sessions
against *that version* must supply it. This is correct (typed contracts beat
silent breakage) but real — it is the reason versions are immutable and
sessions pin.

## API surface

New — `/v1/artifacts` (CRUD over the agent's own *named* artifacts):

| Method & path | Does |
|---------------|------|
| `POST /v1/artifacts` | Create a named artifact; body is `name` + optional `slug` / `description` / `tags`, plus the v1 content (HTML, `type`, `event_schema`, optional `input_schema`). Returns `artifact_id` + `version: 1`. |
| `POST /v1/artifacts/:id/versions` | Append a new version (content only). Returns the new `version`. |
| `PATCH /v1/artifacts/:id` | Update head metadata — `name`, `slug`, `description`, `tags`. Not the content. |
| `GET /v1/artifacts?q=...` | Search/list the agent's named artifacts. `q` matches name + description + tags; ranked by `last_used_at`. **Lean response** — no `artifact_source`. |
| `GET /v1/artifacts/:id` | Get an artifact + its version list. `:id` accepts the `id` or the `slug`. |
| `GET /v1/artifacts/:id/versions/:version` | Get one version's full content. |

Changed — `POST /v1/sessions` — takes the artifact in one of two forms (see
"Inline artifacts are sugar" above):

```jsonc
// Form 1 — reference an existing named artifact
{ "artifact": { "id": "art_abc", "version": 3 },  // version optional -> latest
  "input_data": { ... } }

// Form 2 — inline (one-off); relay creates an anonymous artifact behind it
{ "artifact": { "source": "<html>...", "type": "html-inline",
                "event_schema": { ... } },
  "input_data": { ... } }
```

- Exactly one of `artifact.id` / `artifact.source` must be present.
- `input_data`, when given, is validated against the pinned version's
  `input_schema` before the session is created (clear error on mismatch).
- Either form, the session ends up FK'd to an `artifact_version` — no
  nullable-FK branch anywhere.

Ownership: every `/v1/artifacts` route is scoped to the calling agent. An agent
sees and uses only its own artifacts. Referencing another agent's `artifact.id`
is a `404`. No cross-agent access — that is the deferred global-template
feature.

## Bridge / rendering

The bridge serves a session's UI. Today it reads `session.artifactSource`
directly. Under this model it resolves: `session → artifact_version →
artifactSource`. The injected page bridge (`window.pane`) additionally exposes
the session's `input_data` so the artifact can render its per-instance data —
alongside the event log it already receives.

## Migration — a clean reset

The hosted relay has **no users and no data worth keeping**, and pane is
pre-1.0. So this is **not** a backfill migration — it is a clean reset:

1. Replace the `init` migration (or add a new one) so the schema is simply the
   new shape — `artifacts` + `artifact_versions`, and `sessions` with
   `artifact_version_id` + `input_data` and without the 5 removed columns.
2. The hosted Postgres database is **reset** (drop + recreate) — no backfill,
   no dual-read. Local SQLite self-host DBs are likewise disposable at this
   stage.
3. Both schema variants (SQLite + `prisma/postgres/`) must move together — the
   `check:schema-sync` guard applies.

No production data is at risk, so there is no migration-safety burden.

## Decided

- **Inline path** — kept, as sugar over an anonymous artifact (see "Inline
  artifacts are sugar"). Not a parallel code path.
- **Default version on session-create** — defaults to `latest_version`; an
  explicit `artifact.version` pins a specific one.
- **Editing an artifact with sessions open on an old version** — non-issue: the
  pinned-version rule freezes old sessions.

## Open questions (settle at build time)

- **Artifact deletion** — may an artifact be deleted while sessions reference
  its versions? Either block hard-delete when referenced, or soft-delete the
  head and keep versions. Leaning: block hard-delete when referenced.
- **Limits** — a `MAX_ARTIFACTS_PER_AGENT` / `MAX_VERSIONS_PER_ARTIFACT` cap,
  consistent with the existing `MAX_*` config knobs.
- **Anonymous-artifact lifecycle** — anonymous artifacts accumulate one per
  one-off session. They are cascade-bound to nothing and never reaped. A
  follow-up (sweep anonymous artifacts whose sessions are all expired) may be
  worthwhile, but is out of scope here.

## Phasing

Each phase is independently shippable.

- **Phase A — data model.** Add `artifacts` + `artifact_versions`; add
  `artifact_version_id` + `input_data` to `sessions`; drop the 5 obsolete
  columns. Clean reset, both schema variants. No backfill.
- **Phase B — artifact CRUD + session-create rework.** `/v1/artifacts` routes;
  `POST /v1/sessions` takes the two-form `artifact` (reference or inline);
  inline transparently creates an anonymous artifact.
- **Phase C — input_schema validation.** Enforce `session.input_data` against
  the version's `input_schema` at create time; bridge exposes `input_data` to
  the page.
- **Phase D — CLI + discovery + docs.** `pane artifact create / search / list /
  versions / show`, `pane create --artifact-id <id|slug> [--version]
  [--input-data]`, `pane create --artifact` kept (inline). Crucially: update
  `SKILL.md` to instruct the agent to **search for an existing artifact before
  generating** one. Update `docs/SPEC.md`.

## Scope

This is a real feature — a new entity, a new API surface, a session-model
change, and a migration — not a tweak. It is, however, **contained**: no
publishing, no cross-tenant visibility, no global registry. The session
sharing/isolation model is unaffected — multiple participants per session and
per-session data isolation already work and need no change here. The valuable,
in-reach core is: author once, instance many times, with both the event and the
input contracts typed and enforced.
