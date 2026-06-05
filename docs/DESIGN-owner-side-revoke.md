# Owner-side agent key revoke

Status: draft
Scope: relay HTTP + `/my-agents` SPA. No CLI change required.

## Why

Today an agent key can only be revoked by the agent itself: the caller
authenticates with the key it is about to kill via `DELETE /v1/keys/:id`
(`packages/relay/src/http/routes/keys.ts`). That covers self-destruct
("I no longer need this CI bot") but not the cases that actually matter:

- The owner's machine was lost / repaved and the key is gone with it. The
  owner cannot present the key, so the key cannot be revoked. It keeps
  working for whoever holds it.
- The key leaked (committed to git, posted in a Slack screenshot). The
  legitimate owner and the attacker are now indistinguishable to the relay
  — both can call `DELETE /v1/keys/:id`. The first to act wins, and the
  owner often loses.
- `/my-agents` already shows a `Revoked` pill, lists the key prefix, and
  has a `Regenerate key` button — but no `Revoke` button. The lifecycle is
  half-modelled in the UI.

The `Agent` model already carries `revokedAt` and the auth path already
short-circuits on it (`http/auth.ts:70,110`). What's missing is the
human-scoped path that sets it.

## Proposal

Add **one** new endpoint, mirroring the existing rotate route:

```
POST /v1/self/agents/:id/revoke-key
```

- Auth: `requireHuman` (cookie session, same as rotate).
- Authorization: agent row must satisfy `ownerHumanId = human.id AND
  deletedAt IS NULL`. Anything else 404s — same oracle-avoidance pattern
  rotate uses (`self.ts:81`).
- Effect: `UPDATE agent SET revokedAt = now() WHERE id = :id AND
  revokedAt IS NULL`. Idempotent on a second call (no-op, return current
  `revokedAt`).
- Response: `200 { agent_id, name, revoked_at }`.
- Errors:
  - `404 not_found` — unknown agent, or not owned by caller, or trashed.
  - `400 invalid_request` — already revoked? **No** — return the current
    `revoked_at` as success. Idempotency is friendlier than a 4xx race.

### What revoke does NOT do

- It does **not** trash the agent (`deletedAt` stays null). Revoke and
  trash are independent lifecycle states — `/my-agents` and `system-pages.ts:948`
  comments already encode this distinction. Trash is "hide from default
  views"; revoke is "the credential no longer works". A revoked agent is
  still listed on `/my-agents` with a `Revoked` pill so the owner can see
  what happened.
- It does **not** un-revoke. Rotate already declines revoked agents with a
  misleading hint ("unrevoke the agent first") — see "Cleanup" below.
- It does **not** delete or migrate owned panes/templates. The agent row
  stays as the owner of historical artifacts; only the credential dies.

### Self-revoke (existing) is unchanged

`DELETE /v1/keys/:id` keeps working as-is. It is still the right path for
"agent revokes its own key" — CI bots that want to self-destruct at
end-of-run shouldn't need to round-trip through a human session. The new
route is additive: agent-auth path stays, owner-auth path is added.

## UI: `/my-agents`

Add a `Revoke` button next to `Regenerate key` on each row in
`packages/relay/src/http/routes/system-pages.ts:1018`. Visibility rules:

- Hidden when `revokedAt` is set (nothing to revoke).
- Hidden when `deletedAt` is set (trashed agents are inert).
- Otherwise shown, styled as a destructive ghost button.

Click flow:

1. Inline confirm — replace the row's action area with "Revoke this
   agent's key? It stops working immediately. [Revoke] [Cancel]". No
   modal — match the existing rotate/inline-reveal pattern.
2. On confirm, `POST /v1/self/agents/:id/revoke-key`.
3. Refresh the row: swap the `Active` pill for `Revoked`, hide both
   `Regenerate key` and `Revoke`.
4. On error, surface the API error message inline (existing rotate error
   path is the precedent).

No new copy beyond the button label and confirm text — the page already
explains that claiming records ownership and the key keeps working.

## CLI

No new CLI command. `pane key revoke` is the agent-side flow and stays
self-only — the owner-side path is browser-driven by design (the human
session lives in the cookie, not in `PANE_API_KEY`). If demand appears
later, the obvious shape is `pane self revoke-agent <agent-id>` against
the human session token, but that's a follow-up.

## Connection liveness

`requireAgent` checks `revokedAt` on every HTTP request, so the next
request from a revoked key 401s. Two questions worth answering before
landing:

1. **Live WebSocket connections.** The WS path authenticates at connect
   time (`packages/relay/src/ws/`) and does not re-check `revokedAt`.
   After revoke, an existing socket keeps streaming until the client
   disconnects. Two options:
   - **Accept it (recommended for v1).** Document the window. WS
     connections are short-lived in practice (clients reconnect on
     network blips); the worst case is a few minutes of stale stream.
   - **Force-close.** On revoke, walk active WS connections by
     `agentId` and close with a `4001 revoked` code. Adds a `Map<agentId,
     Set<WebSocket>>` to the WS server. Worth it only if v1 acceptance
     turns out wrong.
2. **In-process cache.** `attachment-bridge.ts:78` keeps a revoke cache
   for participant tokens. Agent auth doesn't — every request hits
   Postgres for the agent row. That's fine for now (agent count is low),
   but if we add a cache later, revoke needs to invalidate it.

## Cleanup (in-scope for the same PR)

`self.ts:99-102` currently errors on rotating a revoked agent with:

> "unrevoke the agent first (or claim a fresh one) before rotating"

There is no unrevoke. Rewrite to:

> "agent is revoked — revocation is permanent; claim a fresh agent and
> retire this one."

This is a one-line copy fix that becomes visibly wrong once the new
revoke button starts producing revoked agents in the UI.

## Tests

E2E (`agents.e2e.test.ts` is the precedent):

- Owner can revoke an owned agent → subsequent agent-auth requests 401.
- Non-owner human gets 404 on someone else's agent.
- Trashed agent gets 404 (mirrors rotate).
- Second revoke is idempotent (200, same `revoked_at`).
- Rotate on a revoked agent still 400s with the updated message.

Unit: none — the route is thin and the auth gate is already covered.

## Out of scope

- Multiple keys per agent (a separate `ApiKey` table). Discussed and
  declined: the current "one key per agent" model is load-bearing for the
  claim flow, and rotate already gives the "I want a fresh credential"
  affordance without breaking ownership. If we revisit, it's a separate
  spec.
- Un-revoke. Permanently destructive is a feature, not a bug — matches
  the agent-side `pane key revoke --yes` semantics.
- Admin/operator-level revoke. The relay has no operator console yet;
  when it does, that route lives next to the other admin tools, not here.
