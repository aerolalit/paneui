# Connect Pane to your AI chat

Pane has two ways in. If you have a **coding agent** (Claude Code, Cursor,
Codex, …) the [README install flow](../README.md#install) installs the CLI +
skill and you're done. This page is for the other case: adding Pane to an **AI
chat app** — Claude on the web, desktop, or your phone, ChatGPT, or any client
that supports remote MCP connectors — **with no install at all**.

You paste one URL, log in once, and Pane shows up as a set of tools your chat
can call. From then on you can ask it to *"build me a pane for …"* and it hands
you back a URL to a real interactive UI.

> **TL;DR** — Add a custom connector pointing at:
>
> ```
> https://relay.paneui.com/mcp
> ```
>
> Authorize it with your email (magic link) and approve the consent screen. That's it.

---

## What this gives you

The chat gets Pane's full tool set — `create_pane`, `get_events`,
`send_to_pane`, the record/template/attachment tools, and the rest (the same
tools the [`@paneui/mcp` server](../packages/mcp/README.md#tools) exposes). So
you can say things like:

- *"Make me a form to capture my trip details and give me the link."*
- *"Build a dashboard of these numbers I can open on my phone."*
- *"Give me an approve/reject pane for this plan and wait for my answer."*

The chat builds the UI, hands you a `relay.paneui.com` URL, you open it on any
device, interact, and your structured answer flows straight back into the
conversation.

**This is the only way to use Pane from a phone or a pure chat app** — there's
no terminal there to run the `pane` CLI or the stdio `@paneui/mcp` server. The
remote connector runs entirely on Pane's hosted relay; your chat only makes
outbound HTTP calls to it.

---

## Before you start

- A **Pane account** on the hosted relay. You don't need to create one in
  advance — the first time you authorize, you'll log in by email (magic link)
  and the account is created on the spot.
- **Remote / custom MCP connectors** must be available in your chat app. On
  Claude this is a feature of the **paid plans** (Pro, Max, Team, Enterprise);
  on other apps, check that they support "custom connectors" or "remote MCP
  servers". Coding agents like Claude Code have it built in.

The connector URL is always:

```
https://relay.paneui.com/mcp
```

(Running your own relay? Use `https://<your-relay-host>/mcp` instead — the same
OAuth flow is built into every self-hosted relay.)

---

## Claude (web, desktop, mobile)

1. Open **Settings → Connectors** (web: <https://claude.ai/settings/connectors>;
   desktop: Settings → Connectors; mobile: profile → Settings → Connectors).
2. Click **Add custom connector**.
3. **Name** it `Pane` and paste the **URL** `https://relay.paneui.com/mcp`.
4. Save, then click **Connect**. A browser window opens on the Pane relay.
5. **Log in** with your email — you'll get a magic link; click it to sign in.
6. On the **consent screen** ("Allow Claude to access your pane account?"),
   review it and click **Allow**. You're redirected back to Claude.
7. The connector now shows **Connected**, and Pane's tools appear in the chat's
   tool list (the 🔌/tools menu).

Try it: start a chat and ask *"Use Pane to build me a quick contact form and
give me the link."* Claude creates the pane, returns the URL, you fill it in,
and the submitted data comes back into the conversation.

> The same connector works across every Claude surface tied to your account —
> add it once on the web and it's available on your phone too.

---

## Claude Code (remote connector, no local server)

Claude Code can use the hosted connector instead of the stdio server — handy if
you'd rather not run anything locally:

```sh
claude mcp add --transport http pane https://relay.paneui.com/mcp
```

Then in Claude Code run `/mcp`, select **pane**, and **Authenticate** — it opens
the browser for the same login + consent flow and stores the token. After that,
Pane's tools are available in the session.

> Prefer streaming and local control? The CLI route (`npm i -g @paneui/cli` +
> the skill) gives you true `pane watch` streaming. See the
> [README install section](../README.md#install). The remote connector and the
> local CLI are interchangeable — use whichever fits.

---

## ChatGPT and other MCP-capable chat apps

Any chat client that supports **remote MCP / custom connectors** can use Pane —
the connector is a standard OAuth-protected Streamable-HTTP MCP endpoint, not a
Claude-specific integration.

- **ChatGPT** — in the clients that expose custom connectors / MCP, add a new
  connector with the URL `https://relay.paneui.com/mcp` and complete the OAuth
  login + consent when prompted.
- **Other clients** (and remote-MCP-capable IDE assistants) — wherever the app
  asks for a *server URL* for a remote/HTTP MCP connector, give it
  `https://relay.paneui.com/mcp`. It will discover the auth endpoints
  automatically and walk you through login + consent.

The flow is identical everywhere: **paste the URL → log in by email → approve
the consent screen**. No API key to copy, no client secret to manage — the
client registers itself and uses PKCE.

---

## Managing the connection

- **One identity per chat.** Each chat app you authorize gets a single Pane
  agent identity bound to your account; re-authorizing the same app reuses it,
  so your panes and templates accumulate under one identity.
- **Disconnect any time.** Remove the connector in your chat app's settings (or
  revoke it from the Pane relay) and its access is revoked immediately. Your CLI
  key and any other connectors are unaffected.
- **Tokens.** Access tokens are short-lived (1h) and refresh automatically;
  refresh tokens last 30 days. Everything is revocable.
- **Scope.** A connection grants full agent access — parity with a CLI key
  (create/read/update panes, records, templates, attachments).

---

## How it works (one paragraph)

Pane's relay is both the **MCP resource server** (`/mcp`) and its own **OAuth
2.1 authorization server**, in one container. When your chat first calls `/mcp`
without a token it gets a `401` pointing at the relay's OAuth metadata; the
client self-registers (Dynamic Client Registration), you log in with the relay's
magic-link flow and approve a consent screen, and the client receives an
access + refresh token. Each token is mapped to a per-human Pane agent, so the
connector acts exactly like a CLI agent against the relay's own API — same auth,
same validation, same scoping. PKCE (S256) is required, redirect URIs are exact-
match allowlisted, authorization codes are single-use, and tokens are opaque +
revocable. The full design is in
[`docs/architecture/remote-mcp-oauth.md`](architecture/remote-mcp-oauth.md).

---

## Troubleshooting

- **"Connect" does nothing / no browser opens** — make sure pop-ups aren't
  blocked, then retry. The relay must be reachable at
  `https://relay.paneui.com` (check <https://relay.paneui.com/healthz>).
- **The consent screen says the client is "not verified by pane"** — that's
  expected. Pane allows open client registration (so apps like Claude mobile can
  connect), so it can't pre-verify every client. Check the **redirect host**
  shown on the consent screen is the app you're actually authorizing before you
  allow it.
- **My chat app has no "custom connector" option** — remote connectors are a
  paid-plan feature on most chat apps. If yours doesn't support remote MCP, use
  a coding agent with the CLI/skill instead (see the
  [README](../README.md#install)) or the local stdio server
  ([`@paneui/mcp`](../packages/mcp/README.md)).
- **Tools don't appear after connecting** — reopen the chat's tool/connector
  menu; some clients need the conversation restarted to pick up a new connector.

---

## See also

- [README — Install](../README.md#install): the coding-agent and CLI install paths
- [`@paneui/mcp`](../packages/mcp/README.md): the local **stdio** MCP server (Claude Desktop config, Cursor, generic hosts) and the full tool list
- [`docs/architecture/remote-mcp-oauth.md`](architecture/remote-mcp-oauth.md): the connector's OAuth 2.1 design and security model
- [`skills/pane/SKILL.md`](../skills/pane/SKILL.md): the agent-facing reference for everything Pane can do
