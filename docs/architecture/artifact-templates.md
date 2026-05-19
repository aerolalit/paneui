# Reusable Artifacts (design note)

Status: **PROPOSED** — design of record, not yet built and not on a committed
roadmap. Captured so the model is reviewed before any code.

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
  name          String
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

New — `/v1/artifacts` (CRUD over the agent's own artifacts):

| Method & path | Does |
|---------------|------|
| `POST /v1/artifacts` | Create an artifact; body is the v1 content (HTML, `event_schema`, optional `input_schema`). Returns `artifact_id` + `version: 1`. |
| `POST /v1/artifacts/:id/versions` | Append a new version. Returns the new `version`. |
| `GET /v1/artifacts` | List the calling agent's artifacts (head rows). |
| `GET /v1/artifacts/:id` | Get an artifact + its version list. |
| `GET /v1/artifacts/:id/versions/:version` | Get one version's full content. |

Changed — `POST /v1/sessions`:

- Accepts `artifact_id` (+ optional `version`, default `latestVersion`) instead
  of inline `artifact` / `schema`.
- Accepts `input_data`; the relay validates it against the pinned version's
  `input_schema` before creating the session.
- **Ad-hoc path retained:** an inline `artifact` + `schema` (today's shape) is
  still accepted for one-off UIs that are not worth saving as an artifact. The
  relay implements this by transparently creating a single-version, unnamed,
  owner-scoped artifact behind the scenes — so `sessions` always FKs to an
  `artifact_version`, with no nullable-FK branch. (Implementation choice; could
  also be a private "scratch" flag — decide at build time.)

Ownership: every `/v1/artifacts` route is scoped to the calling agent. An agent
sees and uses only its own artifacts. No cross-agent access — that is the
deferred global-template feature.

## Bridge / rendering

The bridge serves a session's UI. Today it reads `session.artifactSource`
directly. Under this model it resolves: `session → artifact_version →
artifactSource`. The injected page bridge (`window.pane`) additionally exposes
the session's `input_data` so the artifact can render its per-instance data —
alongside the event log it already receives.

## Migration

Not a behaviour-preserving no-op — `sessions` loses columns. Sketch:

1. Add `artifacts` + `artifact_versions` tables.
2. Backfill: for every existing session, create a one-version artifact from its
   inline `artifact_*` / `event_schema`, and set `artifact_version_id`.
3. Drop the inline `artifact_type`, `artifact_source`, `event_schema`,
   `artifact_version`, `schema_version` columns from `sessions`.
4. Both schema variants (SQLite + Postgres) must move together — the
   `check:schema-sync` guard applies.

Because pane is pre-1.0 and the hosted relay's data is disposable, a clean
cutover (drop + recreate) is also acceptable and simpler — decide at build time.

## Open questions

- **Default version on session-create** — `latestVersion`, or require the
  caller to name a version explicitly? Defaulting to latest is convenient but
  means a new artifact version silently changes what new sessions get. Leaning:
  default to latest, allow an explicit pin.
- **Editing an artifact while sessions are open on the old version** — the
  pinned-version rule already handles correctness (old sessions are frozen).
  Confirmed non-issue; listed for completeness.
- **Ad-hoc artifacts** — transparent single-version artifact vs. a `scratch`
  flag vs. keeping a nullable inline path. Three options; pick at build time.
- **Artifact deletion** — may an artifact be deleted while sessions reference
  its versions? Either block it, or soft-delete the head and keep versions for
  referencing sessions. Likely: block hard-delete when referenced.
- **Limits** — a `MAX_ARTIFACTS_PER_AGENT` / `MAX_VERSIONS_PER_ARTIFACT` cap,
  consistent with the existing `MAX_*` config knobs.

## Phasing

Each phase is independently shippable.

- **Phase A — data model.** Add `artifacts` + `artifact_versions`; add
  `artifact_version_id` + `input_data` to `sessions`. Backfill + drop inline
  columns. Migration only.
- **Phase B — artifact CRUD.** `/v1/artifacts` routes. Sessions can now be
  created from a saved artifact; the inline path still works.
- **Phase C — input_schema validation.** Enforce `session.input_data` against
  the version's `input_schema` at create time; bridge exposes `input_data` to
  the page.
- **Phase D — docs + SDK/CLI.** `pane artifact create` / `pane create
  --artifact-id`; update `docs/SPEC.md` and the skill.

## Scope

This is a real feature — a new entity, a new API surface, a session-model
change, and a migration — not a tweak. It is, however, **contained**: no
publishing, no cross-tenant visibility, no global registry. The session
sharing/isolation model is unaffected — multiple participants per session and
per-session data isolation already work and need no change here. The valuable,
in-reach core is: author once, instance many times, with both the event and the
input contracts typed and enforced.
