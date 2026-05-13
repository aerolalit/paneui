# Phase 3: The human side (shell, sandboxed iframe, bridge)

This is the part `docs/SPEC.md` flags as "the part you can't get wrong." Read the Security section twice.

## Scope

In:
- `GET /s/:token`: the **shell** page (the trusted outer document the relay serves from its own origin).
- `GET /s/:token/content`: the **agent's artifact**, served wrapped, with the `pane.*` shim injected, behind a strict CSP, to be loaded inside a sandboxed iframe.
- The shell's WebSocket connection to `WS /v1/sessions/:id/stream` (phase 2). Replay on connect; live event push.
- The `pane.*` shim API (`pane.emit`, `pane.on`, `pane.state`, the `ready` / `init` handshake).
- The postMessage protocol between the iframe and the shell (the wire format, the validation the shell does).
- All the security headers (CSP, frame options, referrer policy, cache).

Out:
- The MCP server, deploy, dogfood (phase 4).
- One-time links: v1 ships multi-open links (see Open decisions); `?once=1` is later.
- Schema validation: lives in phase 2 (server-side). The shim is dumb and forwards; the relay validates.

## Architecture: the two-document model

There are two HTML documents in play, with very different trust:

**Outer = the shell.** Served by the relay from `PUBLIC_URL`'s origin. Trusted (it's our code). Small: minimal chrome (a thin "Pane session" header with a status pip), one `<iframe>`, and the WebSocket handler. It is the *only* code that talks to the relay for this session (it opens the WS and forwards iframe events as WS frames). It validates everything that comes out of the iframe before forwarding.

**Inner = the agent's artifact.** Served by `GET /s/:token/content`. Untrusted (an agent wrote it; could be hostile or just buggy). It runs in:

```html
<iframe sandbox="allow-scripts" src="/s/{token}/content"></iframe>
```

Crucially without `allow-same-origin`, without `allow-forms`, without `allow-top-navigation`. That puts the inner document in an *opaque origin*, which means it:

- cannot read or write the shell's DOM (`parent.document` throws; cross-origin),
- cannot read cookies / localStorage for `PUBLIC_URL`,
- cannot `fetch` / `XHR` / `WebSocket` / `EventSource` anywhere (CSP `connect-src 'none'` blocks all four),
- cannot navigate the top frame (`allow-top-navigation` not granted),
- cannot submit forms, open popups, run plugins.

Its only outbound channel is `window.parent.postMessage`. The shell receives those, validates them, and is the thing that actually writes to the relay (via the WS). Picture the iframe as a sealed box with one mail slot.

**Should `/s/:token/content` be served from a different origin than the shell** (e.g. `content.<domain>`, or a per-session subdomain), for defense in depth even against a sandbox escape? Ideal: yes. v1: **same origin is acceptable** because the sandbox already denies same-origin access (no "same origin" privilege for the inner doc to abuse). Ship same-origin in v1; document the separate-content-origin upgrade as a v1.1 / hosted hardening. **OPEN** (lean: same origin v1).

## The `pane.*` shim

The relay injects a small script into the wrapped inner document that defines `window.pane` before any of the agent's markup or scripts run. **Inlined** (not an external `bridge.js`) so there's no extra round trip and the CSP can stay tight (allowed via a per-response nonce in `script-src`). **DECIDED**: inline + nonce.

API surface (v1):

```ts
pane.emit(
  type: string,
  data?: object,
  opts?: { causationId?: string, idempotencyKey?: string }
): Promise<{ id: string }>

pane.on(type: string, handler: (event) => void): () => void   // returns unsubscribe

pane.state: ReadonlyEventLog
```

`ReadonlyEventLog` exposes:
- `state.events`: an array of all known events (full envelopes), in id order.
- `state.last(type?)`: the most recent event (or most recent of `type` if given).
- `state.subscribe(fn)`: coarse "anything changed" callback. The fine-grained way is `pane.on(type, fn)`.

**There is NO `pane.submit(...)`.** "Submit" is just an event type the agent's schema declares (e.g. `review.submitted`, `form.completed`). The artifact emits it like any other event. The agent on the other end (phase 4's MCP server) calls `await_pane_result({ terminal_event_type: "review.submitted" })` to wait for it.

The handshake: on `DOMContentLoaded`, the shim posts `{ __pane: 1, v: 1, kind: "ready" }` to the parent. The shell waits for its WS replay to complete, then replies `{ __pane: 1, v: 1, kind: "init", payload: { session_id, schema, replay: [...events...] } }`. The shim seeds `pane.state` from `replay`, then accepts further `{kind:"event"}` pushes from the parent for live updates.

## The postMessage protocol (wire format), v1

iframe → shell:

- `{ __pane: 1, v: 1, kind: "ready" }`: sent once on `DOMContentLoaded`.
- `{ __pane: 1, v: 1, kind: "emit", id: <emit-cookie>, type: string, data: object, causation_id?: string, idempotency_key?: string }`: every `pane.emit()`. `id` is a client-side correlation cookie so the shim can resolve the `Promise` when the shell relays the server's ack.

shell → iframe:

- `{ __pane: 1, v: 1, kind: "init", payload: { session_id, schema, replay } }`: sent in reply to `ready`, once the WS replay completes.
- `{ __pane: 1, v: 1, kind: "event", payload: <full event envelope> }`: every live event pushed by the WS (from any author). Includes the artifact's own events once the server has accepted them.
- `{ __pane: 1, v: 1, kind: "ack", id: <emit-cookie>, event_id: string, deduped?: boolean }`: server accepted the event the shim emitted with this `id`.
- `{ __pane: 1, v: 1, kind: "error", id: <emit-cookie>, error: { code, message, details } }`: server rejected (e.g. 422 schema_violation, 403 author_not_allowed, 410 gone).

What the shell validates on **every** inbound `message` from the iframe before doing anything with it:

1. `event.source === iframeEl.contentWindow`: it's from *our* iframe, not some other window. (Identity, not origin: the sandboxed frame's origin is the string `"null"`, so an origin check is useless; the `source` identity check is the one that matters.)
2. `event.data` is a plain object with `__pane === 1` and `v === 1`.
3. `kind` is one of the known values (`"ready"`, `"emit"`).
4. For `kind: "emit"`: `type` is a non-empty string ≤ 64 chars; `data` is a plain object whose `JSON.stringify` length ≤ `MAX_EVENT_DATA_BYTES`. `causation_id` / `idempotency_key` if present are short strings.

Anything failing any check: ignore it, bump a per-session counter; past a threshold, stop listening and show "this UI is misbehaving." Never forward an unvalidated message.

On a valid `kind: "emit"`, the shell sends a WS frame:

```json
{ "type": ..., "data": ..., "causation_id": ..., "idempotency_key": ... }
```

The server replies on the WS with `{ "ack": <event_id> }` or `{ "error": ... }`. The shell relays back to the iframe as `{kind:"ack", id, event_id}` or `{kind:"error"}`.

Live events pushed by the WS (from any author) are forwarded to the iframe as `{kind:"event", payload}`.

**Why route through the shell instead of letting the iframe open its own WS?** The iframe can't (CSP `connect-src 'none'` blocks WebSocket too). Even if we relaxed CSP, funneling through the shell gives us: (a) one place to validate / rate-limit / debounce, (b) one CSP story (`connect-src 'none'` is airtight), (c) the shell owns the token (the artifact never sees it). **DECIDED**: through the shell.

## The WebSocket connection (in the shell)

The shell, on load, after authing the human via the URL-path token:

1. Opens `WS /v1/sessions/:session_id/stream?token=<participant_token>`. (Browsers don't allow `Authorization` headers on `new WebSocket()`; the participant token rides as a query param. The relay extracts it on upgrade.) **OPEN**: query-string token vs a one-shot `POST /v1/sessions/:id/connect` that returns a short-lived WS-only cookie. Lean: query-string for v1; revisit if the URL-leak surface bothers us.
2. Receives the event-log replay, accumulates it in a local buffer.
3. On `{kind:"system.replay.complete"}` (control frame, not stored), sends the iframe the `init` message with the schema and the replay buffer.
4. Forwards every subsequent live event to the iframe.
5. Sends every iframe `emit` as a WS frame and forwards the server's ack / error back to the iframe.

On WS disconnect: reconnect with exponential backoff (`1s, 2s, 5s, 10s, 30s` max). On reconnect, request a replay since the last seen event id (the WS endpoint supports `?since=` on connect). The shim's `pane.state` is preserved across reconnects; only new events arrive.

On `system.artifact.updated`: the shell reloads the iframe's `src` (the `artifactVersion` bump triggers a fresh `/content` fetch). The event log is preserved across the reload.

On `system.session.expired`: the shell flips its chrome to "this session is closed" and tears down the iframe (or leaves it visible read-only; see Open decisions).

## The wrapping rule for `GET /s/:token/content`

The relay never serves the agent's artifact raw; it always wraps, so it controls `<head>`, the CSP nonce, and the shim:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script nonce="{NONCE}">/* the pane.* shim, inlined */</script>
</head>
<body>
  {AGENT_ARTIFACT}
</body>
</html>
```

`{AGENT_ARTIFACT}` is `session.artifactSource` for `html-inline`, or fetched-and-cached for `html-ref`. If the agent sent a full document (`<!doctype html>...`), we still drop it into `<body>` of our wrapper. The agent's `<style>` / `<script>` / markup all still work. The agent SHOULD send a fragment; sending a full doc is tolerated but the wrapper wins. **DECIDED**: always wrap, relay owns `<head>`. (We do not parse or sanitize the agent's HTML beyond size-capping. The sandbox + CSP are the containment, not HTML sanitization.)

## Security headers: exactly

On `GET /s/:token` (the shell, our trusted page):

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-{N1}'; style-src 'self' 'nonce-{N1}'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cache-Control: private, no-store
```

(`frame-ancestors 'none'` + `X-Frame-Options: DENY`: the shell must never be embedded in another page. `frame-src 'self'`: the shell may embed `/s/:token/content`, same-origin in v1. `connect-src 'self'`: the shell's WS goes to `WS_URL`, same origin in v1.)

On `GET /s/:token/content` (the agent's artifact, loaded inside the sandboxed iframe):

```
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' 'nonce-{N2}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
Content-Type: text/html; charset=utf-8
Cache-Control: private, no-store
```

Why `script-src 'unsafe-inline'`: the agent's artifact is hand-written HTML+JS. Inline `<script>` is the whole point; so we allow it. Safe because the frame is sandboxed (opaque origin, no same-origin privileges) AND `connect-src 'none'` means that inline script cannot `fetch` / `XHR` / `WebSocket` / `EventSource` anywhere. It can't exfiltrate, can't phone home, can't call the relay. The only thing it can do is `postMessage` to the parent (which `connect-src` doesn't govern), and the parent validates that. We do NOT allow `'unsafe-eval'`. The nonce `{N2}` is what the injected shim uses; the agent's own inline scripts run under `'unsafe-inline'`. `frame-ancestors 'self'`: the content page may only be framed by our own shell.

Token hygiene: the participant token lives in the URL **path** for `/s/:token` (paths are logged less aggressively than query strings, and `no-referrer` keeps it out of `Referer`). For the WS handshake the token rides as a query string (browser-API limitation; see Open decisions). It will still appear in browser history and the relay's access logs; accept that for v1. Don't log the full path at `info`; redact in access logs (`/s/<token>` → `/s/***`, `?token=...` → `?token=***`).

## Interfaces (what phase 3 must expose)

- `GET /s/:token` → the shell HTML (above headers). If the token doesn't match a `Participant.tokenHash` → `404`. If the session is `closed` → still serve the shell, but it shows the terminal state instead of an interactive iframe (it can replay the historical event log read-only).
- `GET /s/:token/content` → the wrapped agent artifact (above headers). `404` if no session / participant. If `status != "open"`, serve it read-only (the iframe renders the historical state via the replayed event log; emits get a `410 gone` from the WS and the shim surfaces it as `pane.emit` rejecting).
- The `pane` global available inside the iframe: `pane.emit(type, data, opts?)`, `pane.on(type, handler)`, `pane.state`, with the `ready` → `init` handshake automatic.
- The postMessage wire format above (the `__pane` / `v` / `kind` envelope).
- The WS connection lifecycle (open with query-string token, replay, live, reconnect-on-drop, artifact-reload-on-update).

## Acceptance criteria

- Open `${PUBLIC_URL}/s/<token>` in a real browser → the shell loads, opens the WS, receives the replay, the iframe renders the agent's artifact, the browser console shows zero CSP violations for a well-behaved UI.
- Inside the agent's artifact, `await pane.emit("hello", { a: 1 })` resolves to `{ id: "..." }` and a row exists in `events` (verify via `GET /v1/sessions/:id/events`).
- A second browser opens the same URL → both see each other's emits live (`pane.on("hello", ...)` fires in browser B when browser A emits).
- `pane.emit("not.in.schema", {})` rejects with `{ code: "unknown_event_type" }`. `pane.emit("review.commentAdded", { wrong: 1 })` rejects with `{ code: "schema_violation", details: ... }`.
- A human posting an agent-only event type → rejects with `{ code: "author_not_allowed" }`.
- Replay on reconnect: kill the WS mid-session; the shell reconnects with `?since=<last_seen>` and the local `pane.state.events` length doesn't decrease and doesn't double-count.
- `system.artifact.updated`: agent PATCHes the artifact → the iframe reloads, the artifact runs fresh, `pane.state` is preserved.
- A hostile test artifact confirms the box is sealed: `document.cookie` for the shell origin is empty / inaccessible; `fetch("/v1/sessions/...")` and `fetch("https://evil.example/")` are both blocked by CSP `connect-src 'none'`; `top.location = "..."` does nothing; `parent.document` throws; `window.open(...)` is blocked.
- An oversized `postMessage` payload (over `MAX_EVENT_DATA_BYTES` serialized) is dropped by the shell and never reaches the WS.
- A `postMessage` to the shell from a *different* window (not the iframe) is ignored (the `event.source === iframe.contentWindow` check).
- The shell's own page cannot be iframed (load it inside another page → blocked by `X-Frame-Options` / `frame-ancestors`).
- Access logs show `/s/***`, not the real token.

## Open decisions

- **Content origin**: same-origin-as-shell in v1 (lean, relying on the sandbox) vs a separate origin / per-session subdomain (defense in depth against a sandbox escape). Document the upgrade path either way. OPEN.
- **`targetOrigin` from the iframe's `postMessage`**: `"*"` + shell-side `event.source` check (lean) vs threading the shell's exact origin into the shim. OPEN.
- **WS token transport**: query string (`?token=...`) on the WS endpoint (lean, simplest) vs a one-shot `POST /v1/sessions/:id/connect` returning a short-lived WS-only cookie. OPEN.
- **Closed-session content**: read-only artifact (lean) vs `410 Gone` outright. Lean: read-only so the human can see what they answered. OPEN.
- **One-time vs multi-open links** in v1: multi-open (lean; `?once=1` can be a fast-follow) vs single-use now. OPEN.
- Inline-shim-with-nonce, route-events-through-the-shell, always-wrap-the-artifact, no-`pane.submit`-verb, WS-in-the-shell, artifact-reload-on-`system.artifact.updated`: all **DECIDED** above.
