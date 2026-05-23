# Pane vocabulary — naming proposal

> Status: proposal, not committed. Discuss in an issue / PR before any
> data-model rename ships.

Pane's data model has accumulated names that are individually defensible but
collectively impose a glossary tax: `artifact` for a UI template, `session`
for one use of it, `blob` for a binary attachment, `bridge` for the shell
page, `shim` for the injected runtime. None of these are wrong; several are
slightly mis-tuned for the audience pane is actually written for (engineers
authoring agent-side code), and the friction compounds as new readers
arrive.

This document is the consolidated end-state we'd land on if we were naming
the system today, plus a phased rollout that doesn't force a breaking change
unless we're already shipping one.

## The full naming table

Every concept in pane today, plus the two arriving with identity-bound auth.
Each row has a one-line reason — short on purpose; the goal is the table,
not an essay.

| Status | Name | Reason |
|---|---|---|
| keep | `Agent` | The machine actor. Industry-standard now (MCP, "LLM agents"). No overload, no better word. |
| rename | `Session` → **`Surface`** | "Session" is the most overloaded word in web (HTTP session, login session, etc.); the auth collision is hypothetical today, inevitable later. "Surface" also describes the row more honestly — a rendered substrate the agent hands the human, not a connection state. |
| rename | `Artifact` → **`Template`** | Pairs naturally with the instance noun: *"a template is reusable; a surface is one instantiation of it."* Matches web-dev template conventions (Django/Jinja/Handlebars). Avoids the "build output" connotation that `Artifact` carries from CI/CD. |
| rename | `ArtifactVersion` → **`TemplateVersion`** | Mechanical follow-on. |
| keep | `Participant` | Genuinely the right word. Works equally well for anonymous-capability and identity-bound rows. `Invite` is wrong (survives acceptance); `Member` implies long-lived org-style membership. |
| keep | `Event` | Universal primitive. `Message` would imply chat; `Action` implies only human-side. Event covers both directions and is the standard wire word. |
| rename | `Blob` → **`Attachment`** | `Blob` is SQL/storage vocabulary leaking to the API. "Attachment" reads naturally to engineers and non-engineers alike. "Blob" can stay internally for the binary-content concept; the user-facing noun is Attachment. |
| rename | `BlobToken` → **`AttachmentToken`** | Follows. Keep `Token` as the suffix — it honestly says "single-use credential" in a way `Link` doesn't. |
| keep | `Feedback` | Self-explanatory. No overload, no improvement available. |
| rename (internal) | `Bridge` → **`Shell`** | "Bridge" was a metaphor; "Shell" is the literal thing — the outer HTML page wrapping the sandboxed iframe. Frees "bridge" for prose ("the relay bridges agents and humans"). No API impact. |
| rename (internal) | `shim` → **`runtime`** | "Shim" implies "small compatibility layer," which it isn't. It's a runtime — injected code that exposes the host API inside the sandbox. Less mysterious to readers. No API impact. |
| keep | `Taste` | Evocative and accurate — captures the soft, learned-preferences nature better than `Preferences` or `Style`. |
| keep | `Skill` | Established Claude/MCP convention. Diverging would only confuse people coming from that ecosystem. |
| keep | `Relay` | Perfect word for what the server does. Zero rename pressure ever. |
| new | **`Human`** | Resist `User` — it drags SaaS-account baggage (plans, billing, "users of the product"). A human is just a human. |
| new | **`Login`** | One row = one logged-in state. Reads naturally: `Login.cookieHash`, "expired login", "revoke this login". No need for the awkward `HumanLogin` prefix; the table name stands on its own. |

## The diff at a glance

```text
Session            →  Surface
Artifact           →  Template
ArtifactVersion    →  TemplateVersion
Blob               →  Attachment
BlobToken          →  AttachmentToken
Bridge             →  Shell             (internal)
shim               →  runtime           (internal)
+  Human                                 (new)
+  Login                                 (new)
```

## What the API / CLI reads like after

```sh
pane template create --slug pr-review …
pane template list
pane surface create --template-id pr-review --input-data …
pane surface watch sur_xxx --type review.submitted
pane surface participant new sur_xxx --identity alice@example.com
pane attachment upload ./photo.jpg --surface-id sur_xxx
```

```http
POST /v1/templates
POST /v1/surfaces
POST /v1/surfaces/:id/participants
POST /v1/attachments
WS   /v1/surfaces/:id/stream
```

No overloaded nouns. The template/instance relationship is in the names
themselves: instantiate a template into a surface.

## Why each rename earns the breakage

Three picks above are the load-bearing data-model renames. The reasoning is
worth recording so we can argue with it later from a position of having
written it down rather than recalling a Slack thread.

### `Session → Surface`

The argument *against* was straightforward: "session" is what every web dev
already calls a held, stateful, multi-event connection. We'd lose a familiar
word.

The argument *for*, which won:

- **Auth collision is permanent.** As soon as humans are first-class, you
  have HTTP login sessions. Naming one of them `HumanLogin` to dodge the
  collision is a workaround, not a fix. Free the word now.
- **More honest description.** A pane "session" isn't really a session in
  the HTTP sense — it's a rendered UI substrate with a lifetime, on which
  events accrete. "Surface" carries that meaning directly. "The agent hands
  the human a surface" reads correctly the first time.
- **Cheap to do once, costly to do later.** Every week of delay grows the
  rename surface (CLI, API, docs, SKILL.md, downstream agents).

### `Artifact → Template`

The artifact/session pair is one of the most-explained relationships in
pane's docs today. The reason it needs explaining: the names don't carry the
relationship. "Artifact" and "session" share no semantic root.

Template + Surface (or Template + Session, if Surface doesn't land) does
carry the relationship — *instantiate a template into a surface* — and
matches a pattern web devs already know from Django, Jinja, Handlebars, ERB,
Liquid, EJS. The "but a template implies placeholders" objection is too
strong: a Jinja template with no `{{ vars }}` is still a template, just a
static one. A view-only pane artifact maps onto exactly that.

The `Artifact` name *also* misleads, in the opposite direction: in CI/CD
parlance an artifact is a **build output** — the *result* of a process.
Pane artifacts are the **source / input** that produces sessions. Reversing
that on every new reader is a tax.

### `Blob → Attachment`

Internal storage *is* a blob — SQL-canonical, short, accurate. But the
user-facing noun on the API leaks an implementation detail. "Attachment"
reads to engineers and non-engineers alike; "blob" needs a glossary entry.
Keep `Blob` internally for the binary-content concept; rename the
outward-facing noun.

## Recommended rollout

Three tiers, in cost-ascending order. Each tier is **one PR** — don't
piecemeal. Renaming `Session` without also renaming `Artifact` and `Blob`
creates an inconsistent vocabulary that's *worse* than either consistent
state.

### Tier 1 — internal cleanup, no API impact

Cheap. No CLI change, no API change, no migration. Pure readability.

- `Bridge` → `Shell` in code and docs.
- `shim` → `runtime` in code and docs.

### Tier 2 — identity-bound auth, additive, no rename

Land alongside the auth work. All existing rows behave identically; new
rows opt in.

- Add `Human` table.
- Add `Login` table.
- Add `Participant.humanId` as a nullable FK; existing rows get `null`.

### Tier 3 — the data-model rename, bundle with v2 API

Breaks the public surface. Defer until there's a v2 API release to bundle
with.

- `Session` → `Surface`
- `Artifact` → `Template`
- `Blob` → `Attachment` (with token + version follow-ons)

Requires: API v2, CLI breaking change, SKILL.md rewrite, full doc sweep,
downstream agent migration.

**Right window: before broader adoption.** Every week of delay multiplies
the migration surface. Past the adoption inflection point, skip Tier 3
entirely — the naming wins don't pay for the breakage.

## Honest read

If pane stays small and engineer-only, Tier 3 is over-investment — the
current names are flawed but understood. If pane is heading toward broader
adoption (CI bots, no-code automation, non-developer users), Tier 3 pays
back because every new user pays the glossary tax otherwise.

My lean: **defer Tier 3 until there's a concrete plan for v2 of the public
API anyway**, then bundle the rename into that release. Don't do it as a
standalone breaking change. The naming choices stand independently of when
they ship.
