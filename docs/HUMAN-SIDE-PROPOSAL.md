# Human-side pane — architecture proposal

> Status: proposal, not committed. The intent of this document is to capture
> the design discussion as a written artefact so future contributors can argue
> with the choices from the record, not from chat memory. Nothing here ships
> until at least one of the rollout phases is approved and tracked as a
> separate piece of work.
>
> Companion doc: [`NAMING-PROPOSAL.md`](./NAMING-PROPOSAL.md). The names in
> this doc use the *current* schema (`Session`, `Artifact`, `Blob`). If the
> naming proposal lands the equivalent terms are `Surface`, `Template`,
> `Attachment`; the architectural shape doesn't depend on which name set
> wins.

## 1. Motivation

Today pane is asymmetric. **Agents are first-class** — they hold API keys,
create artifacts, mint sessions, manage participants. **Humans are reactive**
— they open a URL the agent hands them, interact with whatever the agent
rendered, and have no UI of their own to manage anything. Every human-facing
surface in pane today is something an agent built and pushed to one human.

That works for the canonical use case (an agent needs a rich answer from a
human) but it ceilings what pane can be. A human can't:

- See the list of surfaces they're a participant on.
- See which agents act on their behalf.
- Open a dashboard over their own pane data.
- Pick a *view* of their data — a list, a Kanban, a calendar — and switch
  between them at will.
- Invite a second human into an existing surface.
- Pull other humans' surfaces into their workflow.

The thesis of this document: **make the human first-class, and let templates
be the entire UI**. Dashboards, settings, inboxes, list-views are all just
pane templates the human renders over their own data. Pane the platform
becomes a small opinionated backend that serves: identity, an event log, a
template catalog, a participation model. Everything visible is a template —
including the home page.

This is a meaningful conceptual shift and a meaningful schema change, hence
the proposal.

## 2. The conceptual model

The core shifts from today, condensed:

| Concept | Today | Proposed |
|---|---|---|
| Humans | Reactive holders of capability URLs | First-class identities with logins |
| Agents | Standalone, API-keyed, the owner of every session | Standalone *or* claimed by a human; first-class participants on surfaces, not owners |
| Sessions | Owned by exactly one agent (`Session.agentId` required) | Owned by exactly one **human** (common case) or **agent** (standalone case). Agents are *participants*, not owners. |
| Artifacts | Created by agents, instanced per session | Owned by humans (via claimed agents); auto-flow into the owning human's catalog OR globally published + installed |
| Sharing | One agent → one human (or a small set), capability URLs | Multi-participant: any mix of humans and agents; identity-bound and capability tokens coexist |
| Auth | Agent API keys only | Human Login (magic-link cookie) + Agent API keys + scoped tokens for installed third-party templates |
| Dedup | None — every `pane create` makes a new session | `(template, owner, contextKey)` — same logical thing reuses one row |

The remainder of this document fills in the mechanics of those rows.

## 3. Data model

### 3.1 New tables

```
Human
  id           pk
  email        unique
  verifiedAt   datetime?      -- non-null once first magic-link login succeeds
  phone?       string?
  createdAt    datetime

Login
  id           pk
  humanId      fk → Human
  cookieHash   unique
  expiresAt    datetime
  createdAt    datetime
  lastSeenAt   datetime
```

Notes:

- No password column. v1 auth is magic-link email. OAuth and passkeys are
  later additions and don't require schema changes (they fit alongside
  `Human.email` as separate identity providers).
- `verifiedAt` is a datetime rather than a boolean so auditing has the
  *when*. Same storage cost, strictly more useful.
- `Login` is named `Login` rather than `Session` so the pane primary noun
  isn't displaced. If the naming proposal renames the primary noun to
  `Surface`, the cleanest call is to also rename `Login` to `Session` at
  that point — but it's not a dependency.

### 3.2 Changes to existing tables

```
Agent
+ ownerHumanId  fk → Human, nullable
+ claimedAt     datetime?, nullable
```

- Standalone agents stay null-owner — today's behaviour is preserved.
- Claimed agents have an owning human. The transition is one-way (no
  unclaim flow in v1).
- All artifacts and surfaces created by a claimed agent count toward the
  owning human's catalog.

```
Session   (or Surface, per the naming proposal)
- agentId        REMOVED  (was required)
+ ownerHumanId   fk → Human, nullable
+ ownerAgentId   fk → Agent, nullable
+ contextKey     string,  nullable
+ creatorKind    "human" | "agent" | "system"
+ creatorId      string  (humanId | agentId | "system")

  UNIQUE INDEX (artifactId, ownerHumanId, contextKey) WHERE ownerHumanId NOT NULL
  UNIQUE INDEX (artifactId, ownerAgentId, contextKey) WHERE ownerAgentId NOT NULL
  CHECK (ownerHumanId IS NOT NULL) <> (ownerAgentId IS NOT NULL)
```

- Exactly one of `ownerHumanId` / `ownerAgentId` is set. The owner
  determines dedup namespace and invitation policy.
- `contextKey` is the natural key for "same logical thing": `"home"`,
  `"pr:42"`, etc. `NULL` `contextKey` means "make a fresh surface every
  call" (the today behaviour for ad-hoc agent sessions).
- `creatorKind`/`creatorId` is recorded for audit but is **not load
  bearing** — it answers "who instantiated this" without conferring
  privilege. All privilege flows from `owner*` and `participants`.

```
Participant
+ humanId   fk → Human, nullable
+ agentId   fk → Agent, nullable

  CHECK (kind = 'human') = (humanId IS NOT NULL)
  CHECK (kind = 'agent') = (agentId IS NOT NULL)
```

- Participants are now polymorphic: exactly one of `humanId` / `agentId`
  is set, matching `kind`. Today the `kind` is `"agent"` for the owner
  participant and `"human"` for everyone else; in the new model `kind`
  remains, but both kinds are first-class peers.
- `tokenHash`, `tokenPrefix`, `joinedAt`, `revokedAt` columns are unchanged.
- An identity-bound participant has its `humanId`/`agentId` set; an
  anonymous capability participant has both null (the token is the only
  identity). Both forms coexist.

### 3.3 What the surfaces table looks like by example

```
artifact      owner             contextKey   participants
─────────────────────────────────────────────────────────────────────────
home          human=alice       "home"       [alice]
my-surfaces   human=alice       "list"       [alice]
settings      human=alice       "settings"   [alice]
pr-review     human=alice       "pr:42"      [alice, agent=reviewer-1, agent=reviewer-2]
pr-review     human=bob         "pr:42"      [bob]            ← different surface, same context key
pr-review     human=alice       "pr:43"      [alice, agent=reviewer-1]
form-once     human=alice       NULL         [alice, bob]     ← ad-hoc, no dedup
ci-status     agent=ci-bot      "build:#891" [ci-bot]         ← standalone agent, no human owner
```

Each row is one surface. The dedup index ensures Alice's `pr:42` review
collapses to one row no matter how many of her agents call
`pane session create --template-id pr-review --context-key "pr:42"`.

## 4. Authentication and trust

### 4.1 Three identity types

- **Agent identity** — `agent_<id>` API key. Today's mechanism. Used by the
  agent to call `/v1/*` for its own work. Unchanged.
- **Human identity** — `Login` cookie issued after magic-link verification.
  Used by templates (and the relay UI) to act on behalf of the human.
- **Anonymous participant identity** — a capability token (`tok_h_…`) in
  the URL. Identifies which participant row a request is acting as; no
  attached human.

A single request to the relay carries **at most one** of these. Mixing
forms isn't supported — the route layer picks the strongest identity
present and rejects ambiguous combinations.

### 4.2 Login flow (magic link)

1. Human visits `relay.paneui.com` while logged out.
2. Server serves the login page (a static asset, **not** a template — see
   §5.2 bootstrap).
3. Human enters their email; relay sends a single-use magic link with a
   short-lived token (15 min TTL).
4. Human clicks the link; relay validates, sets the `Login` cookie,
   redirects to the home template surface.
5. On first successful login, `Human.verifiedAt` is set.

The cookie is HTTP-only, `SameSite=Lax`, `Secure` in production, scoped to
the relay's bridge origin. Templates running in the artifact iframe do
**not** see the cookie directly — they call the API via the runtime, which
proxies through the shell (same-origin) so the cookie attaches naturally.

### 4.3 Three trust tiers for templates

Not all templates are equal. The relay enforces different auth at the API
boundary based on where the template came from:

| Tier | Source | Auth model | Scope |
|---|---|---|---|
| **System** | Pane-shipped (home, lists, settings) | Login cookie | Anything the human can do |
| **Own** | Created by an agent the human owns | Login cookie | Anything the human can do |
| **Installed** | Globally published + Alice clicked install | Login cookie **plus** the template's declared scopes | Only the union of those scopes |

For System and Own, the relay treats the human's cookie as full
authorisation — these templates are trusted because the human owns them or
pane authored them. For Installed third-party templates, the cookie is
still required, but the runtime additionally tags each API call with the
template's identity, and the relay rejects calls that fall outside the
template's declared scope set.

### 4.4 Scope vocabulary (v1 draft)

```
read:surfaces
write:surfaces        — create, update metadata
delete:surfaces       — close / remove

read:participants
write:participants    — invite, revoke (but not delete:human)

read:templates
write:templates       — author, version

read:agents           — list owned agents (not their secrets)
write:agents          — invite, claim — never reveal API keys

read:attachments
write:attachments
delete:attachments

read:self             — current human profile

read:events           — surface event log
write:events          — emit agent-side events into surfaces the template
                        is on
```

Templates declare scopes at publish time as metadata on the template
version. At install, the human sees the requested scopes ("This template
wants to read your surfaces and write events. Install?"). The relay
enforces the union at every API call.

`delete:*` scopes are always shown to the human as a separate confirmation,
not bundled into "write". This is the structural defence against malicious
templates: a template that doesn't declare `delete:*` cannot delete
anything no matter how it misbehaves.

### 4.5 What templates can NEVER do, regardless of scopes

- Read another human's data.
- Reveal an agent's API key (even one the human owns).
- Invite an agent into a surface (only humans can do that — see §7.4).
- Modify the human's email, phone, or login credentials.
- Bypass the iframe sandbox or run code in the shell origin.

These are *structural prohibitions* enforced at the relay or in the shell,
independent of the scope set. A template asking for them is a configuration
error, not a permission request.

## 5. Templates as the entire UI

### 5.1 The catalog

Templates fall into one of three catalogs:

- **System catalog** — pane-shipped templates the relay holds. Always
  available to every human. Identified by reserved slugs (`home`,
  `my-surfaces`, …).
- **Own catalog** — templates created by an agent the human owns. These
  auto-appear in the human's "My Templates" without an explicit publish
  step. No install flow.
- **Public catalog** — templates explicitly published globally by any
  agent or human. Browsable. Installable.

A template metadata row gains:

```
Artifact
+ publishedAt   datetime?    -- null until publish:public called
+ scopes        json[]?      -- declared at publish time, frozen per version
+ installCount  int          -- cached, public-catalog ranking signal
```

### 5.2 The bootstrap problem (it's a template all the way down — almost)

If every UI is a template, the question "what template renders when Alice
visits `pane.com`?" is recursive. Two carve-outs:

- **The login page is not a template.** It's a static HTML route the relay
  serves. Logged-out humans can't run templates because they don't have
  cookie auth to call the runtime APIs.
- **The home template is hardcoded at first login.** Pane ships a default
  `home` template that the relay serves to any logged-in human who hasn't
  set a custom home. Humans can override their home pick in Settings (also
  a template), which writes to `Human.homeTemplateId`.

After login, **everything else** is a template. Even the settings page that
lets you pick a different home.

### 5.3 The v1 system catalog

Minimum scope pane has to ship for the human-side experience to feel
complete:

| Slug | What it does | Owner | contextKey |
|---|---|---|---|
| `home` | Favourites + recent activity + links to other system templates | human | `"home"` |
| `my-surfaces` | List of surfaces the human participates on | human | `"list"` |
| `my-templates` | List of templates the human owns or has installed | human | `"list"` |
| `my-agents` | List of agents the human has claimed | human | `"list"` |
| `settings` | Email, home template pick, claim-code generation | human | `"settings"` |
| `surface-detail` | One surface deep view (alternate to the regular bridge) | human | `"surface:<id>"` |
| `template-detail` | One template deep view | human | `"template:<id>"` |
| `agent-detail` | One agent deep view (managing claim, revoking, viewing surfaces) | human | `"agent:<id>"` |
| `participants` | Per-surface participant manager (invite, revoke) | human | `"surface:<id>:participants"` |

The login page is **not** in this list — it's a static route, not a
template (§5.2). Everything else above is a real pane template, the same
primitive a third party would publish.

### 5.4 The runtime API surface (`window.pane`)

Templates today only have `pane.emit`, `pane.on`, `pane.state`,
`pane.inputData`, `pane.downloadBlob`, `pane.uploadBlob` etc. The
human-side world adds a `pane.api.*` namespace for the relay's HTTP API,
proxied through the shell so the cookie attaches:

```js
pane.api.surfaces.list({ filter: "mine" | "shared" | "all" })
pane.api.surfaces.show(id)
pane.api.surfaces.delete(id)
pane.api.surfaces.create({ templateId, contextKey, inputData })

pane.api.participants.list(surfaceId)
pane.api.participants.invite(surfaceId, { humanEmail | agentId })
pane.api.participants.revoke(surfaceId, participantId)

pane.api.templates.list({ scope: "system" | "own" | "installed" | "public" })
pane.api.templates.show(id)
pane.api.templates.install(id)        // public template → my catalog
pane.api.templates.publish(id, { scopes })

pane.api.agents.list({ scope: "mine" | "standalone" })
pane.api.agents.claim(code)
pane.api.agents.revoke(id)

pane.api.self.profile()                // current human
pane.api.self.generateClaimCode()      // for granting an agent ownership
```

Every call returns a promise; every call carries the template's identity
when the relay is scope-checking installed templates (§4.3). The runtime
is the contract — the underlying HTTP layout can change without breaking
templates.

## 6. The claim flow (human ↔ agent)

Standalone agents work today without any human attached (CI bots,
scratch scripts). The claim flow is the **one-way transition** that turns
a standalone agent into a human-owned agent.

### 6.1 Flow

1. Alice opens the `settings` template, clicks **Claim an agent**.
2. Settings calls `pane.api.self.generateClaimCode()` — relay creates a
   one-shot, short-TTL code (15 min) tied to `humanId=alice`. Returns the
   code string and shows it on screen.
3. Alice copies the code, hands it to the agent (paste into CLI, env var,
   MCP install screen — out of band, on Alice's choosing).
4. Agent calls `POST /v1/agents/claim { code }` using its existing API
   key. Relay validates the code's TTL + ownership, then:
   - Sets `Agent.ownerHumanId = alice.id`.
   - Sets `Agent.claimedAt = now()`.
   - Migrates ownership of all surfaces/templates from `ownerAgentId =
     agent.id` to `ownerHumanId = alice.id` (rewrite the `owner*` columns
     in a transaction).
   - Invalidates the code.
5. Agent's response carries the claim confirmation; the agent can persist
   the human's email for future reference but is not given a new API key
   — its existing one still works, just now scoped under Alice.

### 6.2 Why human-initiated

The alternative (agent-initiated claim invite) lets agents pick which
human owns them, which is the wrong direction for trust. Human-initiated
matches OAuth device flow, GitHub deploy keys, and MCP install — patterns
users already know.

### 6.3 What can't be unclaimed in v1

Once an agent is claimed, it stays claimed. Revoking the agent (Alice
hits **Revoke** in `my-agents`) deletes the API key and tombstones the
row; it does not return the agent to standalone. Re-using an agent
identity after revoke means creating a new one with a fresh key. This is
the simplest semantics and matches GitHub's deploy-key UX.

## 7. Surface lifecycle in the new model

### 7.1 Creation

A surface is created by one of three actors:

- **Agent (standalone)** — calls `POST /v1/sessions` as today. Owner is
  the agent.
- **Agent (claimed by Alice)** — calls `POST /v1/sessions`. Owner is
  Alice (the relay derives this from `Agent.ownerHumanId`). The agent
  becomes the first agent-participant on the surface; Alice is *not*
  auto-added as a participant unless `--invite-owner` is set.
- **Human (Alice via template)** — template calls
  `pane.api.surfaces.create(...)`. Owner is Alice. Alice is auto-added as
  the first human-participant.

On creation, the relay checks the dedup index. If `(artifactId, owner,
contextKey)` already exists, the existing surface is **returned** rather
than a new row created (idempotent). The created/joined response
distinguishes the two with `created: true | false`.

### 7.2 Invitation policy (Google Docs default)

| Inviter | Can invite | Restriction |
|---|---|---|
| Owner human | Any human, any agent | Always allowed |
| Human participant (non-owner) | Other humans | Default ON; owner can disable per surface |
| Human participant (non-owner) | Agents | Default ON; owner can disable per surface |
| Agent participant | Anyone | **Never** in v1 — no agent can invite. Co-host grants for agents are a future addition. |

The relay enforces this at `POST /v1/sessions/:id/participants`. Each
surface gains `Surface.invitePolicy`: a small JSON blob with toggles
matching the matrix above. Default is the permissive Google-Docs-style
settings; owner can lock down per surface.

### 7.3 Joining

When an agent is invited to a surface mid-stream, it receives the
existing event log on connect (replay, no special replay request — the
WS handshake just streams all prior events first, then live ones). This
matches the today behaviour for any participant joining a session
already in progress, generalised to agents.

### 7.4 Why agents can't invite other agents

If an agent could invite agents without human sign-off, a malicious
agent could pull other agents into a surface to exfiltrate. The "human
must invite agents" rule means an agent expansion needs a human in the
loop. Co-host grants — where Alice gives her CodeReviewer agent the
power to invite peer agents into PR surfaces — are deferred to a future
proposal; the additive change would be a `Participant.canInvite` column
and a new scope `write:invitations`.

## 8. Template distribution

### 8.1 The two channels

- **Auto-flow.** Any template authored by an agent Alice owns appears
  immediately in Alice's "my-templates" list. No publish step. This is
  the common case: Alice's own agents make templates for her own use.
- **Public publish + install.** An agent (or human directly) calls
  `pane template publish-public --scopes <list>`. Template enters the
  global public catalog. Another human browses the catalog, picks one,
  clicks install. Relay creates a `HumanTemplateInstall` row binding
  Alice's `humanId` to the template id and the **specific version** at
  install time (no auto-upgrade — humans see a "new version available"
  prompt on the next visit to that template).

### 8.2 New tables

```
HumanTemplateInstall
  id              pk
  humanId         fk → Human
  artifactId      fk → Artifact
  installedVersion int       -- pin to a version at install
  installedAt     datetime
  uninstalledAt   datetime?
```

Auto-flow templates don't get an install row — they're surfaced by the
relay via the join `Artifact.ownerHumanId = humanId` (where ownership
flows from `Agent.ownerHumanId`).

### 8.3 Update flow

The relay shows "v3 available" in the template-detail surface when a
template the human has installed publishes a new version. The human
explicitly upgrades. No silent updates. Reason: a new version may declare
new scopes; the human must re-consent.

## 9. Migration

This is a meaningful schema change. The proposed migration is **additive
where possible**, with the rename-style changes deferred to whenever the
naming proposal lands. Concretely:

1. **Phase A — additive (back-compat).** Land everything in §3 and §4
   that doesn't break existing data:
   - Add `Human`, `Login`, `HumanTemplateInstall` tables.
   - Add `Agent.ownerHumanId` (nullable), `Agent.claimedAt`.
   - Add `Participant.humanId`, `Participant.agentId` (both nullable).
     Backfill from `kind`: existing `kind = 'human'` rows get
     `humanId = ?`, but we don't have human ids for existing rows — see
     below.
   - Add `Session.ownerHumanId`, `Session.ownerAgentId`,
     `Session.contextKey`, `Session.creatorKind`, `Session.creatorId`.
     Keep `Session.agentId` as a deprecated alias of `ownerAgentId` until
     phase C.
   - Add `Artifact.publishedAt`, `Artifact.scopes`,
     `Artifact.installCount`.

2. **Phase B — backfill.** Existing rows:
   - All existing `Session` rows: `ownerAgentId = agentId`,
     `ownerHumanId = NULL`, `contextKey = NULL`,
     `creatorKind = 'agent'`, `creatorId = agentId`.
   - All existing `Agent` rows: `ownerHumanId = NULL` (everything was
     standalone).
   - All existing `Participant` rows with `kind = 'agent'`:
     `agentId = Session.agentId`. With `kind = 'human'`: `humanId = NULL`
     (anonymous capability participant; we never had identities).

3. **Phase C — flip the foreign key.** Once Phase B is verified, drop
   the `Session.agentId` column. Then the model in §3 is exactly what's
   on disk.

4. **Phase D — naming.** If/when the naming proposal lands, the table
   renames in [`NAMING-PROPOSAL.md`](./NAMING-PROPOSAL.md) Tier 3
   apply on top.

## 10. v0 → v1 user journey

What the world looks like end-to-end after this lands (the journey
Lalit narrated in elicitation):

1. Alice visits `relay.paneui.com`.
2. Logged out → served the login page (static). Enters email. Magic link.
3. Logged in → relay redirects to her home template surface
   (`templateId = home`, `contextKey = "home"`).
4. The home template renders: favourites she's pinned, recent surfaces,
   links to other system templates (`my-surfaces`, `my-templates`,
   `my-agents`, `settings`).
5. Alice clicks "my surfaces" → relay creates-or-fetches her
   `my-surfaces` surface (deduped on `(artifactId=my-surfaces,
   ownerHumanId=alice, contextKey="list")`). The template renders her
   list — surfaces she owns and surfaces she's been invited to.
6. Alice picks a PR-review surface from the list → opens the bridge for
   it.
7. Later: Alice goes to settings, generates a claim code, pastes it into
   her CodeReviewer agent's config. Agent claims. From now on, any
   template the CodeReviewer publishes shows up in Alice's
   `my-templates` automatically.

## 11. Open decisions

Things I deliberately left undecided in this draft because they're
implementation details that don't change the architecture:

- **OPEN — Claim code TTL.** Suggested 15 min. Could be a setting.
- **OPEN — Event-log retention for system-template surfaces.** Home and
  list views probably don't need an event log at all — they're views
  over relay state. Two options: (a) keep the events table empty for
  these surfaces; (b) skip the surface row entirely and render
  statelessly. (a) is simpler, (b) saves storage. Lean toward (a) for
  consistency.
- **OPEN — Scope vocabulary final list.** §4.4 is a draft. Will be
  refined as templates get authored — every new API call may add or
  refine a scope.
- **OPEN — Multi-tenant data model in the relay.** Today the relay is
  effectively single-tenant per agent API key. Once humans exist as
  rows, do we add an `org` or `tenant` boundary above the human, or
  treat all humans as global peers? Lean: keep it flat in v1; add tenant
  later if a customer needs it.
- **OPEN — Magic-link provider.** Self-host needs to declare an SMTP /
  Resend / SES config. Out of scope here.
- **OPEN — Capability URLs vs. identity-bound URLs side-by-side.**
  Today's `tok_h_…` capability tokens keep working unchanged.
  Identity-bound participants get added as a parallel mechanism; the
  relay decides at redeem time which it's looking at.
- **OPEN — Where the human's homepage URL actually lives.** Is it
  `relay.paneui.com` (the relay's own root) or a separate
  `app.paneui.com` to keep the auth surface and the artifact iframe
  origins clearly separated? CSP and cookie scope arguments push for
  two origins; simplicity pushes for one. Lean: two origins for hosted,
  one for self-host (env-var-controlled).

## 12. What would land first

Sequenced for least-risky-first:

1. **Phase A schema** (§9.1) — additive, ships in a normal migration,
   no behaviour change.
2. **Login flow + `Human` row creation** (§4.2). All existing API
   surfaces still work; new `/v1/auth/*` routes are added.
3. **System catalog: `home`, `my-surfaces`, `my-agents`, `settings`**
   (§5.3). Initial four templates. The rest follow.
4. **Claim flow** (§6). The settings template gains the "generate
   code" button; the agent CLI gains `pane agent claim`.
5. **Multi-participant + invitation policy** (§7). Real schema flip
   from `Session.agentId` required to optional.
6. **Public template catalog + install flow** (§8). The most ambitious;
   needs scope enforcement (§4.3 & §4.4) live before this is safe.
7. **Surface dedup via `contextKey`** (§3.2 / §3.3). Land late so the
   existing `pane create` semantics keep working until templates and
   home page actually need the dedup.

Items 1–4 are the human-side MVP — Alice can log in, see her surfaces,
manage her agents. Items 5–7 are the multi-participant + marketplace
extensions.
