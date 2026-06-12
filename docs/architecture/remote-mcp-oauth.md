# Remote MCP connector (OAuth-protected Streamable-HTTP MCP)

This document describes how the pane relay exposes a **remote MCP endpoint**
that a hosted MCP client (claude.ai web, Claude mobile, Claude Code) can add as
a custom connector, and the **self-hosted OAuth 2.1 authorization server** that
protects it.

## Goal

Let a human add pane to Claude as a custom connector by URL
(`https://relay.paneui.com/mcp`), log in + consent once, and then drive all 26
pane tools from Claude — including from Claude mobile, which has no terminal and
cannot run the stdio `@paneui/mcp` server.

## Architecture: resource server + authorization server, both on the relay

```
                    ┌──────────────────────────── relay (Hono) ───────────────────────────┐
 Claude (client)    │                                                                       │
   │                │   Resource server                  Authorization server               │
   │  initialize    │   ┌──────────────┐                 ┌───────────────────────────────┐  │
   ├───────────────▶│   │  /mcp        │                 │ /.well-known/oauth-*           │  │
   │  (no token OK) │   │  Streamable  │                 │ /oauth/register  (DCR)         │  │
   │                │   │  HTTP MCP    │                 │ /oauth/authorize (+ consent)   │  │
   │  tools/call    │   │  transport   │                 │ /oauth/token     (code+refresh)│  │
   ├───────────────▶│   │              │   401 +         │ /oauth/revoke                  │  │
   │  (no token)    │   │   ───────────┼── WWW-Auth ────▶│                               │  │
   │                │   │              │                 └───────────────────────────────┘  │
   │                │   │  verify      │                          │ provisions              │
   │  tools/call    │   │  access tok ─┼──▶ per-human Agent ◀──────┘ (ownerHumanId)          │
   ├───────────────▶│   │  → PaneClient│        │                                            │
   │  (Bearer pmt_) │   │  (loopback)  ├────────┘ acts AS that agent via the relay's own     │
   │                │   └──────────────┘          /v1 API (127.0.0.1:PORT)                   │
   └────────────────┴───────────────────────────────────────────────────────────────────────┘
```

Both roles live in the **same Hono app** so a single container is the connector.
The MCP SDK's `mcpAuthRouter` is Express-only, so the OAuth endpoints are
hand-rolled native Hono routes that reuse the relay's existing magic-link login
cookie for the human consent step.

## OAuth flow (what Claude does)

1. Claude POSTs `tools/call` to `/mcp` with no token → the relay returns
   **401** with
   `WWW-Authenticate: Bearer realm="pane", resource_metadata="<relay>/.well-known/oauth-protected-resource"`.
2. Claude GETs `/.well-known/oauth-protected-resource` (RFC 9728). It points at
   the relay as the authorization server and at `<relay>/mcp` as the resource
   (RFC 8707 audience — exact-match, no trailing-slash drift).
3. Claude GETs `/.well-known/oauth-authorization-server` (RFC 8414) →
   authorize/token/register/revoke endpoints + `code_challenge_methods: [S256]`.
4. Claude self-registers via `/oauth/register` (RFC 7591 DCR). Claude is a
   public client (`token_endpoint_auth_method: none`) — no client secret, PKCE
   only. Its redirect URI (`https://claude.ai/api/mcp/auth_callback`, or a
   localhost loopback for Claude Code) is stored as an exact-match allowlist.
5. Claude opens `/oauth/authorize?...&code_challenge=...&code_challenge_method=S256`.
   The relay requires a logged-in human (bounces to `/login` if not), then
   renders a minimal **consent screen** ("Allow `<client>` to access your pane
   account?"). On **allow**, the relay provisions (or reuses) a per-human
   `Agent` (`ownerHumanId` set, `claimedAt` set) and mints a single-use
   authorization code bound to `client_id + redirect_uri + PKCE challenge + the
   agent`, then redirects to Claude's `redirect_uri` with `?code=&state=`.
6. Claude POSTs `/oauth/token` with the code + `code_verifier`. The relay
   verifies PKCE (S256), the exact redirect_uri, and single-use, then issues an
   **access token** (1h) + **refresh token** (30d).
7. Claude calls `/mcp` again with `Authorization: Bearer <access>`. The relay
   verifies the token → the mapped agent → builds a `PaneClient` keyed as that
   agent and dispatches the 26 tool handlers.

## Token → identity mapping

- An access/refresh token is opaque (`pmt_…`); only its `sha256` is stored
  (`oauth_tokens.token_hash`), exactly like Agent keys and Participant tokens.
- Each token carries the mapped agent's **plaintext API key, AES-256-GCM
  encrypted** with `PANE_SECRET_KEY` (`oauth_tokens.agent_key_enc`, via
  `crypto.ts`). `verifyAccessToken` decrypts it so the MCP request can act AS
  the agent against the relay's own `/v1` API. This reuses **every** existing
  auth/validation/scoping path — the OAuth agent behaves exactly like a CLI
  agent — rather than duplicating logic on an in-process service path.
- The PaneClient loops back to `http://127.0.0.1:PORT` so the call never leaves
  the box.
- One MCP agent per human (`name` prefix `claude-mcp`). Repeat authorizations
  reuse it (and rotate its key); the human's panes/templates accumulate under
  one identity.

## Why opaque-token-in-DB (not a JWT)

Revocation is a first-class requirement ("disconnect Claude without rotating my
CLI key"). An opaque token checked against a DB row makes `revokedAt` an
instant, durable kill switch; a stateless JWT would need a denylist anyway. The
agent-key envelope also has to live somewhere server-side, so the DB row is the
natural home.

## Security decisions

- **PKCE S256 REQUIRED.** `/authorize` rejects a missing/non-S256 challenge;
  `/token` rejects a missing/wrong `code_verifier` (constant-time compare).
- **Exact redirect_uri match** at both registration-allowlist and code-binding
  time — no normalization, no prefix match (open-redirect defence). A bad
  `client_id`/`redirect_uri` at `/authorize` renders an inline error and does
  **not** redirect.
- **Single-use authorization codes**, short TTL (5 min), atomically consumed
  (`updateMany … consumedAt: null`); reuse → `invalid_grant`.
- **Human login + consent reuse the existing magic-link flow.** `/authorize`
  and `/authorize/decision` require the `pane_login` cookie; the decision can
  only be made by the same logged-in human.
- **Refresh-token rotation**: a refresh revokes the old refresh + its last
  access token and mints a fresh pair.
- **Revocation** (RFC 7009): revoking a token is idempotent; revoking a refresh
  cascades to its access token. Disconnecting from settings = revoke the row.
- **Capability discovery is unauthenticated** (`initialize`, `tools/list`,
  `prompts/list`, `resources/list`) so Claude can enumerate before consent;
  `tools/call` and all privileged methods require a valid token.
- **CORS** is permissive on `/mcp` and exposes `Mcp-Session-Id`. `/mcp` is
  bearer-auth (never cookie-auth), so the relay's CSRF gate does not apply.
- **Rate limiting**: `/mcp` + `/oauth` + `/.well-known/oauth-*` are mounted
  before the general per-IP limiter (like `/skills` and `/healthz`) so Claude's
  discovery probes aren't throttled; the MCP route does its own auth + 401
  challenge. (A dedicated MCP limiter is a possible future enhancement.)

## Scopes

A single scope, `pane`, granting full agent access (parity with a CLI key).
A read-only split is a documented future enhancement; v1 keeps one scope to
avoid over-building.

## Sessions

Stateful Streamable-HTTP: a `Mcp-Session-Id` is issued on `initialize` and
validated on subsequent requests; one `McpServer` + transport pair is kept per
session. The PaneClient is rebuilt per request from that request's `authInfo`,
so a session created during the unauthenticated discovery phase still acts as
the agent once tokens arrive.

## Data model (Prisma — sqlite + postgres, both migrated)

- `OAuthClient` — DCR'd clients; `redirect_uris` exact-match allowlist.
- `OAuthAuthCode` — single-use codes bound to client + redirect_uri + PKCE
  challenge + the human + the provisioned agent.
- `OAuthToken` — access/refresh tokens (`token_hash`), the encrypted agent key,
  `revokedAt`, refresh→access linkage for rotation.

## The skill, MCP-native

`get_skill` over the HTTP MCP server returns the **MCP-flavoured guide** (tool-
call grammar), composed from `skills/pane/MCP-INVOCATION.md` + the shared
conceptual core extracted from `skills/pane/SKILL.md` (the blocks between
`<!-- pane:core:start -->` / `<!-- pane:core:end -->`). The CLI `pane skill
show` and `GET /skills/pane/SKILL.md` are unchanged (CLI grammar). A
`pane_guide` MCP prompt and a `pane://guide` MCP resource expose the same guide
for MCP-native discovery. Both the stdio and HTTP servers register them.

## Multi-replica note

The per-code agent-key handoff between `/authorize/decision` and `/token` uses a
short-lived in-memory map (the value is already ciphertext). For a single-replica
container this is fine; multi-replica hosting should move it onto the auth-code
row. Tracked as a follow-up.
