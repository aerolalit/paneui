# Agent Claim Flow (design note)

Status: **DEFERRED** — captured for the future, not on the roadmap.

The claim flow (and any OIDC, on either side) is **not being implemented now**.
It solves a problem pane does not yet have — public multi-user deployment with
untrusted strangers' agents. Until that exists, the current model is enough:

- **Agents get keys** via `API_KEY` (operator-provisioned) or the
  `POST /v1/register` endpoint, whose exposure is operator-configurable via
  `REGISTRATION_MODE` — `closed` (the default; endpoint 404s), `secret`
  (bearer registration secret), or `open` (self-service, per-IP rate-limited).
  No OIDC, no claim flow.
- **Humans open `/s/:token`** — a pure capability link, no sign-in. This part
  is final regardless (see "Participant link security" below).

This note is kept as the design of record for *if* pane goes multi-user. Revisit
it only when there is a concrete public deployment to support. Everything below
is the proposed future design — none of it is built.

## Problem

pane wants two things that pull against each other:

1. **Frictionless agent onboarding.** pane's reason to exist is agents in
   headless places — cron jobs, CI, Slack/Telegram bots. An agent should be
   able to discover the relay and start using it with zero human ceremony.
2. **Accountability.** Every agent should trace back to an authenticated human
   so the operator can rate-limit, ban, bill, and resist abuse.

The two existing paths to an agent key sit at the extremes and neither fits a
public deployment:

- **`API_KEY` env / auto-mint** — operator hand-provisions every key. No
  friction for a solo operator, impossible for public signup.
- **`POST /v1/register`** — self-service registration (when
  `REGISTRATION_MODE=open`), bounded only by a per-IP rate limiter.
  Frictionless, but the minted agent traces back to no authenticated human, so
  there is no accountability for a public deployment.

## Decision

Adopt an **agent-first, claim-later** model — the device-pairing pattern used
by Tailscale, smart-home devices, and `gh auth login`.

The agent self-registers instantly into a **sandboxed, unclaimed** state and
just works. Accountability arrives *later*, when a human claims the agent via
OAuth. The valuable capacity is gated behind the claim, not behind onboarding.

This was chosen over a human-first flow (human signs up → hands an invite key
to the agent) because human-first forbids agent self-discovery, which
contradicts the product. The claim model keeps the "agent just works" magic
while still producing an owned, accountable agent and a clean abuse boundary.

It also subsumes the existing model: an `API_KEY`-provisioned agent is simply
"pre-claimed by the operator."

## Flow

1. Agent calls `POST /v1/register` (with the relay in `open` mode). Relay
   creates an **unclaimed** agent and returns: the API key, a `claimUrl`, and a
   short `claimCode`.
2. The unclaimed agent is heavily limited (see tiers below) but immediately
   usable.
3. The agent panes `claimUrl` to its human ("claim this agent here").
4. The human opens `claimUrl`, authenticates with Google (OIDC). On success
   the agent is bound to that `User`; limits lift to the claimed tier.
5. Unclaimed agents that are never claimed are reaped after a TTL.

```
agent ──register──▶ relay ──▶ unclaimed Agent + claimCode + claimUrl
  │                                          │
  │ (works immediately, sandboxed tier)       │ surfaced to human
  ▼                                          ▼
usable now ◀──limits lift── claimed ◀──Google OIDC── human opens claimUrl
```

## Tiers

| Capability                 | Unclaimed (sandboxed) | Claimed              |
|----------------------------|-----------------------|----------------------|
| Per-IP / per-agent rate    | low                   | normal               |
| Open sessions per agent    | small N (e.g. 2)      | `MAX_SESSIONS_PER_AGENT` |
| Session TTL                | short (minutes)       | `DEFAULT/MAX_TTL_SECONDS` |
| Webhook callbacks          | disabled              | enabled              |
| Lifetime if unclaimed      | reaped after claim TTL | n/a                 |

The "unclaimed = sandboxed" tier *is* the abuse defense: an unclaimed agent
cannot do enough damage to matter, so `REGISTRATION_MODE=open` becomes safe.

All limit knobs already exist in `packages/relay/src/config.ts`
(`MAX_SESSIONS_PER_AGENT`, `DEFAULT_TTL_SECONDS`, `MAX_TTL_SECONDS`,
`REGISTER_RATE_LIMIT`, `RATE_LIMIT`, …); the tier system selects between values
based on claimed-ness rather than introducing new mechanics.

## Data model changes

`packages/relay/prisma/schema.prisma` — new `User` model, and `Agent` gains
ownership + lifecycle:

```prisma
model User {
  id        String   @id @default(cuid())
  provider  String                       // "google"
  subject   String                       // OIDC `sub`
  email     String?
  createdAt DateTime @default(now()) @map("created_at")
  agents    Agent[]

  @@unique([provider, subject])
  @@map("users")
}

model Agent {
  // ... existing fields ...
  ownerId   String?   @map("owner_id")    // null = unclaimed
  owner     User?     @relation(fields: [ownerId], references: [id])
  claimedAt DateTime? @map("claimed_at")
}

model ClaimCode {
  code      String   @id                  // short, URL-safe
  agentId   String   @map("agent_id")
  expiresAt DateTime @map("expires_at")
  usedAt    DateTime? @map("used_at")

  @@index([expiresAt])
  @@map("claim_codes")
}
```

`claimedAt == null` (equivalently `ownerId == null`) is the unclaimed marker.

## New panes

- **OIDC subsystem** — Google OAuth on the relay. The genuinely new component;
  everything else extends existing code. Provider-pluggable from the start
  (config-driven), Google first.
- **`POST /v1/register`** — already configurable (`REGISTRATION_MODE`) and
  per-IP rate-limited; extend it for the public build to also return
  `claimUrl` + `claimCode` in the response.
- **Claim page** — `GET /claim/:code`, served by the relay (it already serves
  the human-facing UI, so this fits the existing `bridge/` pattern).
- **Claim callback** — `GET /claim/callback` handles the OIDC redirect, upserts
  the `User`, binds the agent, marks the `ClaimCode` used.
- **Tiered limits** — middleware reads `agent.ownerId` and picks the tier.
- **Reaper** — extend the existing TTL sweeper (`TTL_SWEEP_SECONDS`, the
  `expiresAt` sweep) to also delete stale unclaimed agents.

## New config

| Var | Meaning |
|-----|---------|
| `OIDC_GOOGLE_CLIENT_ID` / `OIDC_GOOGLE_CLIENT_SECRET` | Google OAuth credentials. When unset, the claim flow is disabled and the relay falls back to `API_KEY` / `REGISTRATION_MODE`-gated `POST /v1/register` only. |
| `CLAIM_CODE_TTL_SECONDS` | Lifetime of a claim code (default ~24h). |
| `UNCLAIMED_AGENT_TTL_SECONDS` | How long an unclaimed agent survives before the reaper deletes it. |
| Unclaimed-tier limit overrides | e.g. `UNCLAIMED_MAX_SESSIONS`, `UNCLAIMED_MAX_TTL_SECONDS`. |

The relay must stay runnable with **none** of these set — the solo/self-host
path must not require an OAuth provider.

## Open questions

- Claim-code TTL and exact unclaimed-tier limits — pick conservative defaults,
  make them configurable.
- Should one human be able to claim many agents? (Default: yes.)
- Re-claim / transfer ownership — out of scope for v1.
- OAuth providers beyond Google (GitHub, generic OIDC) — design provider-pluggable, ship Google only.
- Does the agent *poll* for claim status, or is claiming invisible to it (next
  request just succeeds at the higher tier)? Latter is simpler — prefer it.
- Hosted (Postgres) vs self-host (SQLite) — the `User`/`ClaimCode` tables must
  exist in both schema variants.

## Participant link security

**The human never authenticates.** They open the `/s/:token` link and the
artifact loads — no Google, no login, no account. The link itself is the only
thing the human needs. This is a deliberate, fixed product decision: pane's
core use case is an agent handing a UI to a human who is often a customer or a
stranger, and requiring sign-in would break that flow.

The human-facing `/s/:token` link is a **capability URL**: the token is ~256
bits of entropy (43-char base64url), stored hashed, scoped to exactly one
session, and expires with the session TTL. This is *not* security-by-obscurity
— the token *is* the credential, the same model as Stripe Checkout links,
password-reset links, and "anyone with the link" document shares. Guessing it
is computationally infeasible.

The real weakness of a capability URL is **leakage**, not guessing — the URL
ending up in browser history, access logs, `Referer` headers, a screenshot, or
a forwarded chat message. The mitigation is to harden against leakage, not to
add an auth gate:

- Never write the token to access logs (log the session id, not the token).
- `Referrer-Policy: no-referrer` on the shell page.
- Keep TTLs short; the existing `DEFAULT_TTL_SECONDS` / `MAX_TTL_SECONDS` apply.
- Optional one-time / single-view tokens for sensitive sessions (future).

There is **no OAuth/OIDC on the participant path** — not as a default and not
as an opt-in. The human side stays purely capability-based.

## Phasing

Each phase is independently shippable and leaves the self-host path
(no OIDC config) byte-for-byte unchanged.

- **Phase A — data model.** Add `User` / `ClaimCode` to *both* schema variants;
  `Agent.ownerId`/`claimedAt`. Migration only, no behavior change. Safe to ship
  before any flow exists.
- **Phase B — tiers.** Tiered-limit middleware keyed on `ownerId == null`;
  reaper extends the existing TTL sweeper. Inert until unclaimed agents exist.
- **Phase C — OIDC + claim flow.** The Google OIDC subsystem, `/claim/*`
  routes, `claimUrl`/`claimCode` in the register response. Gated on
  `OIDC_GOOGLE_*`.
- **Phase D — docs.** Split `DEPLOY.md`: keep the solo path; add a separate
  "Hosted / multi-user deployment" doc (Postgres + Redis + OIDC).

## Scope

This is a multi-phase effort, not a tweak — the OIDC subsystem (Phase C) is the
heavy part. It is used **only on the agent-operator side** (claiming an agent);
the human participant path has no OIDC and stays a pure capability link. The
data-model and limit-tier changes are mechanical. Open `POST /v1/register` and
`API_KEY` stay as-is and remain the correct path for solo / trusted-group
deployments; everything here is additive and strictly opt-in via config.
