# Relay logging — agent-readability audit (2026-05-30)

This is a report on the logging changes shipped in [PR #266](https://github.com/aerolalit/paneui/pull/266), written from the perspective of an LLM agent that will read pane's logs to answer questions about the running system. The lens: *can an agent answer useful questions about the relay by querying these logs, without writing custom parsers each time?*

---

## What I found before the change

The relay already has a structured JSON logger ([`packages/relay/src/log.ts`](../packages/relay/src/log.ts)) — every line is a self-contained JSON object with `ts`, `level`, `msg`, and arbitrary structured fields. That's the right baseline.

The HTTP request middleware logs every request with `msg=req`, including `reqId`, `method`, `path`, `status`, `ms`. Token-bearing URL segments (`/s/<token>`, `/b/<token>`) are redacted to `/s/***`, `/b/***` before logging — good operational hygiene.

WebSocket lifecycle events log with `msg=ws connected`, `ws closed`, `ws error`, `ws send failed`, `ws writeEvent failed`. Each carries `surfaceId`, `authorKind`, `authorId`. The close log also carries `code`, `reason` (truncated), and `openMs` for connection-duration analysis. The upgrade path is wrapped in a try/catch that logs raw exceptions at error.

**Two gaps stood out:**

1. **WebSocket upgrade rejections were completely silent.** All nine `sendUpgradeError()` call sites (origin mismatch, missing/invalid credential, ticket failure, surface lookup failures, expired/closed surface, connection cap, rate limit) wrote an HTTP status line to the socket and destroyed it — with no log line. To an agent investigating "is someone probing our relay with stale tokens?" or "why are users seeing 403s?", there was literally nothing to query. The rejection happened, the operator response went out, no record.

2. **HTTP `ApiError` rejections produced no rejection-specific log line.** The req middleware logged the status code (so I could see `status=401` on a `msg=req` line), but the *reason* — `unauthorized` vs `cli_upgrade_required` vs `rate_limited` vs `not_found` — was only present in the response body, never in the logs. Aggregating "rejection codes over the last hour" required parsing nothing useful.

The first auditor I dispatched flagged a longer list (no `reqId` in HTTP logs, no `surfaceId` in WS logs, missing close codes, silent Prisma errors during WS upgrade). Re-reading the code those were all wrong — the relay already had them. Worth noting because it changes what's worth shipping: not a sweeping logging overhaul, just two well-scoped gaps.

---

## What changed

Three edits in two files, ~50 lines net:

### 1. `sendUpgradeError` now takes a `reason` and logs once

`packages/relay/src/ws/handler.ts`

```ts
function sendUpgradeError(
  socket: Duplex,
  status: number,
  reason: string,
  context?: Record<string, unknown>,
): void {
  log.info("ws upgrade rejected", { status, reason, ...context });
  // ...existing socket-write + destroy
}
```

Every call site passes a short, bounded reason and the relevant context (always `surfaceId`; `origin` for the CORS rejection; `surfaceStatus` for the expired-surface case). The reasons are a closed enum chosen at the call site:

- `origin mismatch`
- `rate limit exceeded`
- `missing credential`
- `ticket invalid or expired`
- `surface not found (ticket path)`
- `bearer not resolvable`
- `participant surface mismatch`
- `agent not surface owner`
- `surface closed or expired`
- `connection cap reached`

### 2. `app.onError` logs `ApiError` rejections

`packages/relay/src/http/app.ts`

```ts
if (err instanceof ApiError) {
  recordError(err.code);
  log.info("api rejected", {
    reqId: c.res.headers.get("X-Request-Id") ?? undefined,
    code: err.code,
    status: err.status,
    method: c.req.method,
    path: c.req.path
      .replace(/^\/s\/[^/]+/, "/s/***")
      .replace(/^\/b\/[^/]+/, "/b/***"),
  });
  return c.json(/* ... */);
}
```

The `reqId` field is the same UUID the req middleware uses, so the rejection log and the req log can be joined on it exactly — not on a fuzzy `(ts, path, status)` tuple.

### 3. WS heartbeat terminate carries `surfaceId`

`packages/relay/src/ws/handler.ts:97`

```ts
log.debug("ws heartbeat: terminating unresponsive socket", {
  surfaceId: ws.paneSessionId,
});
```

The only WS log site that didn't carry `surfaceId`. Now it does.

---

## How the logs look after this change

### Scenario 1 — agent connects with an expired ticket

**Before:**
```json
{"ts":"2026-05-30T03:51:57.283Z","level":"info","msg":"req","reqId":"abc","method":"GET","path":"/v1/surfaces/sfc_X/stream","status":101,"ms":4}
```
…or nothing at all, if the upgrade was rejected before Hono saw it (which is the actual case for `sendUpgradeError`). You'd have no log line. The socket gets a 401 and a closed connection. Operator-side: silence.

**After:**
```json
{"ts":"2026-05-30T19:00:00.123Z","level":"info","msg":"ws upgrade rejected","status":401,"reason":"ticket invalid or expired","surfaceId":"sfc_X"}
```

### Scenario 2 — stolen API key being probed

**Before:** N hits of `msg=req`, `status=401`, no way to see whether they were all unauthorized for the same reason or different reasons. To distinguish "old key not yet rotated" from "wrong key entirely" required running curl yourself.

**After:**
```json
{"ts":"2026-05-30T19:00:00.111Z","level":"info","msg":"req","reqId":"r1","method":"POST","path":"/v1/surfaces","status":401,"ms":3}
{"ts":"2026-05-30T19:00:00.111Z","level":"info","msg":"api rejected","reqId":"r1","code":"unauthorized","status":401,"method":"POST","path":"/v1/surfaces"}
{"ts":"2026-05-30T19:00:00.214Z","level":"info","msg":"req","reqId":"r2","method":"POST","path":"/v1/templates","status":401,"ms":2}
{"ts":"2026-05-30T19:00:00.214Z","level":"info","msg":"api rejected","reqId":"r2","code":"unauthorized","status":401,"method":"POST","path":"/v1/templates"}
```

`reqId` ties each pair together. `code` is the same enum value the response body carries, so I can aggregate without parsing response bodies.

### Scenario 3 — CSWSH probe

A malicious page tries to open a WS to the relay from a different origin, hoping the browser's same-origin policy won't catch a query-string credential.

**Before:** browser-side error in the attacker's devtools; relay logs are silent.

**After:**
```json
{"ts":"2026-05-30T19:00:00.000Z","level":"info","msg":"ws upgrade rejected","status":403,"reason":"origin mismatch","surfaceId":"sfc_X","origin":"https://evil.example"}
```

Now I can answer "show me any cross-origin upgrade attempts in the last 24h": `msg=ws upgrade rejected AND reason="origin mismatch"`.

### Scenario 4 — DoS via connection cap

A bot opens 1000 sockets against one surface.

**Before:** sockets just stop connecting after the cap, no log signal.

**After:**
```json
{"ts":"2026-05-30T19:00:00.000Z","level":"info","msg":"ws upgrade rejected","status":429,"reason":"connection cap reached","surfaceId":"sfc_X"}
```

Repeated with same `surfaceId` — clear pattern.

---

## How useful are these logs for me (the agent reader)?

Below are the questions an agent like me realistically gets asked about a relay, and what each looked like before vs after.

| Question | Before | After |
|---|---|---|
| "What's the 429 rate on `/v1/surfaces` right now?" | Group `req` lines by `status=429`, no reason. | Group `api rejected` by `code=rate_limited`. Same answer, more precise. |
| "Did anyone hit the WS connection cap today?" | No log signal at all. | `msg=ws upgrade rejected AND reason="connection cap reached"`. |
| "Why did this user see a 401 at 14:32?" | One `msg=req` line, status only. Have to guess. | Pair of lines joined by `reqId`, includes `code` so I know if it was an unauthorized vs expired-key vs cli-skew. |
| "Is anyone probing surface X cross-origin?" | Silence. | `msg=ws upgrade rejected AND reason="origin mismatch" AND surfaceId=sfc_X`. |
| "Trace this surface's WS session lifecycle" | Already worked — `ws connected`, `ws closed` carry `surfaceId`. | Same, plus upgrade rejections for the surface are now visible. |
| "Why did the heartbeat terminate that socket?" | `msg=ws heartbeat...` line had no surfaceId — couldn't tell which surface. | Now joinable to surface history. |

**What I can do efficiently now:**
- Aggregate by `code` or `reason` to get a clean breakdown of rejection causes.
- Join `req` ↔ `api rejected` on `reqId` for exact request-to-failure correlation.
- Filter every log line for a given `surfaceId` to reconstruct its history end-to-end — every WS event, every upgrade attempt, every termination.
- Distinguish probe traffic (origin mismatch, expired ticket, bearer not resolvable) from operational failures (rate-limited, cap-reached).

**What I still can't do:**
- Aggregate rejections by client IP — neither the `req` log nor the new rejection logs carry it. For "who is probing us?", I'd need to add `ip` (derived from `x-forwarded-for` per `TRUSTED_PROXY` config). Out of scope for this PR.
- Tie a successful WS connection to the HTTP request that minted its ticket — they share `surfaceId` but the ticket-mint `req` log and the `ws connected` log have no shared correlation ID.
- Time DB / Redis operations. `ms` is on req only; Prisma calls don't self-time. Out of scope.

---

## Honest answer to "is this efficient for an agent to query?"

For the specific questions this PR was meant to enable — *who's getting rejected and why* — yes. The log shape is now:

- **Greppable** on `msg` (event-type tag).
- **Aggregable** on `code` and `reason` (bounded enums).
- **Joinable** on `reqId` (HTTP request scope) and `surfaceId` (WebSocket session scope).
- **Filterable** without parsing response bodies.

For broader observability questions (per-IP aggregation, cross-protocol correlation, DB-call timing), pane's logs still need more work. But those weren't the gap this PR was scoped to close, and adding them in the same PR would have made it harder to review.

---

## What I'd do next (not in this PR)

Ordered by expected return-on-effort for an agent reading the logs:

1. **Add client IP to the req middleware and rejection logs** — derived from `x-forwarded-for` honouring `TRUSTED_PROXY` config. Unlocks per-IP aggregation, which is the headline use case for security investigation. ~10 lines.
2. **Propagate `reqId` into WS upgrade logs** — the upgrade comes in as an HTTP request, so the header is there. Would let me trace a WS session back to the HTTP upgrade attempt. ~5 lines.
3. **Time Prisma calls at a coarse level** — wrap the client so each query logs `ms` on the slow path. Useful, but a real refactor — separate PR.

---

*Report generated as part of [PR #266](https://github.com/aerolalit/paneui/pull/266).*
