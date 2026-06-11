# @paneui/mcp

A thin **stdio [Model Context Protocol](https://modelcontextprotocol.io) server** for [Pane](https://github.com/aerolalit/paneui). It lets any MCP client — Claude Desktop, Cursor, Windsurf, Cline, your own host — hand a human a rich interactive UI by URL and get structured data back: forms, approvals, pickers, surveys, dashboards, diff/doc review, multi-step wizards.

It is a wrapper, not a reimplementation: all relay I/O goes through [`@paneui/core`](https://www.npmjs.com/package/@paneui/core), and config is shared with the [`pane` CLI](https://www.npmjs.com/package/@paneui/cli) (`~/.config/pane/config.json`) — so the CLI and this server use the **same agent identity**.

## Runtime requirement: Node.js >= 20

The binary is `pane-mcp`. It speaks MCP over stdio and is meant to be launched by an MCP host, not run interactively.

## Quickstart

No global install needed — point your MCP client at `npx @paneui/mcp`. On first use, if no API key is configured, the server auto-registers a fresh agent against the hosted relay and saves the key to the shared CLI store; nothing else to set up.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pane": {
      "command": "npx",
      "args": ["-y", "@paneui/mcp"]
    }
  }
}
```

To pin an existing agent key instead of auto-registering, add an `env` block:

```json
{
  "mcpServers": {
    "pane": {
      "command": "npx",
      "args": ["-y", "@paneui/mcp"],
      "env": { "PANE_API_KEY": "pane_..." }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "pane": {
      "command": "npx",
      "args": ["-y", "@paneui/mcp"],
      "env": { "PANE_API_KEY": "pane_..." }
    }
  }
}
```

### Generic MCP host

Any client that takes a `command` + `args` + `env` works the same way:

```json
{
  "mcpServers": {
    "pane": {
      "command": "npx",
      "args": ["-y", "@paneui/mcp"],
      "env": {
        "PANE_URL": "https://relay.paneui.com",
        "PANE_API_KEY": "pane_..."
      }
    }
  }
}
```

If you'd rather install it globally (`npm i -g @paneui/mcp`), use `"command": "pane-mcp"` with no `args`.

## Configuration

All environment variables are optional — the defaults target the hosted relay and auto-register on first use.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PANE_URL` | `https://relay.paneui.com` | Relay base URL. Set to point at a self-hosted relay. |
| `PANE_API_KEY` | _(auto-registered)_ | Agent API key. If unset, the server registers an agent on first use and saves the key to `~/.config/pane/config.json` (shared with the CLI). |
| `PANE_TOKEN` | — | Alias for `PANE_API_KEY` (for hosts that name secrets `*_TOKEN`). `PANE_API_KEY` wins if both are set. |
| `PANE_AGENT_NAME` | `pane-mcp` | Display name for the auto-registered agent. |
| `PANE_REGISTER_SECRET` | — | Registration secret, only for relays running `REGISTRATION_MODE=secret`. |

Config precedence mirrors the CLI: env vars win over the saved profile, which falls back to the default relay URL.

## Tools

MCP tools are request/response — there is no long-lived "watch". To receive a human's response you **poll** `get_events` with the cursor from the previous call (optionally with `wait_seconds` to long-poll). Each tool description spells out the pattern for the model.

| Tool | What it does |
| --- | --- |
| `create_pane` | Create a pane from inline HTML (+ optional event/record schema). Returns `{ pane_id, url, expires_at }`. **Give `url` to the human.** |
| `get_pane_state` | Fetch a pane's metadata (status, title, expiry) without its event log. |
| `get_events` | Poll the pane's append-only event log for what the human did. Pass `since` (cursor) and optional `wait_seconds` (long-poll). |
| `send_to_pane` | Push an event into an open pane to update the live UI. |
| `list_records` | List rows in a pane's mutable record collection (todos, line items, comments…). |
| `upsert_record` | Create/return a record row (dedups on `record_key`). |
| `update_record` | Update a record row (optional `if_match` optimistic lock). |
| `delete_record` | Soft-delete a record row (the page sees it live). |

**Events vs records.** Events are an append-only journal — forms, approvals, surveys, pickers. Records are a mutable collection where the current state matters more than the edit history — todo lists, kanban boards, comment threads. Reach for records when the page shows several mutable items.

## Typical flow

1. `create_pane` with your HTML + an `event_schema` declaring the events the page emits → returns a `url`.
2. Paste the `url` into the conversation and ask the human to open it.
3. `get_events` with `wait_seconds: 25` in a loop, passing the prior `next_cursor` as `since`, until the awaited event appears.
4. Optionally `send_to_pane` to update the live UI, or use the record tools for mutable collections.

## MCP registry

`server.json` (in this package) carries the metadata for the [official MCP registry](https://registry.modelcontextprotocol.io). Publishing there is a follow-up step for the maintainer.

## License

MIT — see [LICENSE](./LICENSE).
