# Pane vocabulary — naming proposal

> Status: **2026-06 revision** — the live-instance noun is changing from
> `Surface` to `Pane`. The earlier `Session → Surface` decision shipped in
> mid-2026 (see #317); this revision supersedes it. The original rationale
> is preserved at the bottom of this doc so the reasoning trail stays
> intact.

## What's changing in this revision

| Concept | Prior pick (shipped) | New pick |
|---|---|---|
| Reusable HTML+schema definition | `Template` | `Template` (unchanged) |
| One live use of a `Template` | **`Surface`** | **`Pane`** |

Everything else from the prior naming work stands. `Artifact → Template`,
`Blob → Attachment`, `shim → runtime`, `Human`, `Login` — all shipped, all
unchanged.

## Why override Surface → Pane

The original argument for `Surface` was that it describes the row honestly
("a rendered substrate the agent hands the human"). That's still true — but
two things have become clear since:

- **`Surface` over-describes one half of the breadth.** A pane instance can
  be view-only (a report or dashboard the human only reads), interactive
  (a form), agent → human only (a live status feed), or two-way (a chat /
  approval loop). "Surface" implies a single rendered UI substrate, which
  reads correctly for the view-only and interactive cases but under-sells
  the streaming cases. "Pane" carries no commitment about what's inside —
  the same word fits all four shapes equally well.
- **Brand alignment is load-bearing for adoption.** The product is
  `pane`. The CLI is `pane`. The relay is `pane`. Saying "pane surface" or
  "pane session" makes new readers learn the brand word *and* a second
  noun. Renaming the live-instance noun to `Pane` collapses that to one
  word the brand already owns. "Your CI bot sent you a pane" reads exactly
  as the agent-author writes it; nobody asks what a "surface" is in this
  context.

The cost the original decision avoided (collision with HTTP sessions,
shipped CLI/API breakage) is still the cost; this revision says brand
clarity beats descriptive accuracy at this scale.

## The full naming table (current)

| Status | Name | Reason |
|---|---|---|
| keep | `Agent` | The machine actor. Industry-standard now (MCP, "LLM agents"). |
| **rename** | `Surface` → **`Pane`** | One word for the live-instance noun aligns with the product/brand. Doesn't over-describe the view-only vs. interactive vs. streaming breadth. See override note above. |
| keep | `Template` | The reusable HTML+schema definition. Pairs naturally with `Pane`: *"a template is reusable; a pane is one instantiation of it."* |
| keep | `TemplateVersion` | Mechanical follow-on. |
| keep | `Participant` | Right word. Works for capability-link and identity-bound rows. |
| keep | `Event` | Universal primitive; covers both directions. |
| keep | `Attachment` | User-facing noun for binary content. `Blob` survives internally for the storage primitive. |
| keep | `AttachmentToken` | Single-use credential for an attachment. |
| keep | `Feedback` | Self-explanatory. |
| keep | `Bridge` | The Hono routes container, not a metaphor for the shell. Already correctly named. |
| keep | `runtime` | The injected client-side code that exposes the host API inside the iframe (formerly `shim`). |
| keep | `Taste` | Captures the soft, learned-preferences nature. |
| keep | `Skill` | Established Claude/MCP convention. |
| keep | `Relay` | Perfect word for what the server does. |
| keep | `Human` | Resist `User` — drags SaaS-account baggage. |
| keep | `Login` | One row = one logged-in state. |

## What the API / CLI reads like after

```sh
pane template create --slug pr-review …
pane template list
pane create --template-id pr-review --input-data …
pane watch pan_xxx --type review.submitted
pane participants new pan_xxx --identity alice@example.com
pane attachment upload ./photo.jpg --pane-id pan_xxx
```

```http
POST /v1/templates
POST /v1/panes
POST /v1/panes/:id/participants
POST /v1/attachments
WS   /v1/panes/:id/stream
```

Pane-instance ID prefix: `pan_` (was `sur_`, originally `ses_`).
Pre-existing rows with `sur_` / `ses_` prefixes still work — IDs are opaque
downstream, so the prefix change is cosmetic for newly-created rows.

## Why this earns the breakage

Three honest checks:

1. **Consumers.** Pre-1.0, the only consumers are this repo's own CLI and
   the hosted relay. No external out-of-tree consumer is on a pinned old
   shape. No deprecation window required; break clean.

2. **The shipped Surface vocabulary.** `Session → Surface` shipped in #317
   and downstream PRs. Reverting that work is real cost — but the rename
   touches a wide surface either way, and "two consecutive renames" is the
   bill we pay for not landing the final word the first time. The earlier
   doc explicitly framed `Surface` as the better choice *vs. Session*; it
   did not compare against `Pane`. This revision is the consideration we
   skipped.

3. **The window.** The doc previously called out "right window: before
   broader adoption." That window is still open. Past it, this rename
   doesn't pay for itself.

## Scope of the rename

Bundled into **one PR**, no compat shims:

- Prisma model: `Surface` → `Pane`; table `surfaces` → `panes`;
  FK columns `surface_id` → `pane_id` across `events`, `participants`,
  `feedback`, `attachments`, etc.
- Migration on both sqlite + postgres schemas.
- Core types (`@paneui/core`): `createSessionSchema` →
  `createPaneSchema`, `CreateSessionRequest` → `CreatePaneRequest`,
  `listSessionsQuerySchema` → `listPanesQuerySchema`,
  `upgradeSurfaceSchema` → `upgradePaneSchema`, and every dependent type.
  No deprecated re-exports.
- Client (`PaneClient`): `createSession()` → `createPane()`,
  `getSession()` → `getPane()`, `listSessions()` → `listPanes()`, etc.
- Relay routes: `/v1/surfaces` → `/v1/panes` (and every sub-path);
  bridge owner-shell `/surfaces/:id` → `/panes/:id`.
- System pages: `/my-surfaces` → `/my-panes`, all copy, the surface-cards
  CSS class group.
- CLI: top-level promotion. `pane surface <verb>` → `pane <verb>`. The
  `pane template <verb>` group stays as-is. No `pane pane create`
  redundancy.
- ID prefix: new pane rows mint `pan_…`; existing `sur_…` rows continue to
  resolve (IDs are opaque downstream — same approach used when `ses_` →
  `sur_` shipped).
- Docs: `docs/SPEC.md`, `docs/ROADMAP.md`, `skill/pane/SKILL.md`,
  architecture docs.
- Code symbols + variable names: `surfaceId` → `paneId`, `surfaces` arrays
  → `panes`, `seedSurfaceRow` → `seedPaneRow`, `assertSurfaceInScope` →
  `assertPaneInScope`, etc.
- Holdovers culled in the same PR: `createSessionSchema` and every other
  surviving `Session*` symbol; lingering `artifact` mentions in CLI help
  text + SPEC.md.

## Decision history

### Original choice (2026-04, shipped 2026-05): `Session → Surface`

The original argument was twofold:

- **Auth collision is permanent.** As soon as humans are first-class, you
  have HTTP login sessions. Naming one of them `HumanLogin` to dodge the
  collision is a workaround, not a fix. Free the word now.
- **More honest description.** A pane "session" isn't really a session in
  the HTTP sense — it's a rendered UI substrate with a lifetime, on which
  events accrete. "Surface" carries that meaning directly.
- **Cheap to do once, costly to do later.** Every week of delay grows the
  rename surface.

That decision shipped in #317. The auth-collision and descriptive-accuracy
arguments survive into this revision — they're why we *aren't* reverting
to `Session`. The third argument (cheap now, costly later) is also why
this revision is happening *now* rather than after broader adoption.

### Override (2026-06): `Surface → Pane`

See "Why override Surface → Pane" above. The two arguments that won this
round were breadth (Surface over-describes one half of the use cases) and
brand alignment (one word, not two, for new readers).

### Renames already shipped (not revisited here)

- `Artifact → Template` — shipped.
- `Blob → Attachment` — shipped.
- `BlobToken → AttachmentToken` — shipped.
- `shim → runtime` — shipped.
- `Human`, `Login` — landed with the Phase D identity work.
