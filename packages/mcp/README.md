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

This server has **full parity with the [`pane` CLI](https://www.npmjs.com/package/@paneui/cli)** — every capability the CLI exposes is reachable here.

MCP tools are request/response — there is no long-lived "watch". To receive a human's response you **poll** `get_events` with the cursor from the previous call (optionally with `wait_seconds` to long-poll); to watch a record collection, re-call `list_records` with the prior `since`. Each tool description spells out the pattern for the model.

To keep the tool list compact (a flat 50+ tools would bloat client context and degrade selection), **hot-path nouns stay discrete tools** while **multi-verb management nouns collapse into one tool each with a required `action` enum**.

### Hot-path (discrete) tools

| Tool | What it does |
| --- | --- |
| `create_pane` | Create a pane — inline HTML (`name`+`html`) **or** reuse a saved template (`template_id`). Optional event/input/record schema, participants, tags, icon, callback, `context_key`. Returns `{ pane_id, url, urls, title, expires_at }`. **Give `url` to the human.** |
| `get_pane_state` | Fetch a pane's metadata (status, title, expiry) without its event log. |
| `get_events` | Poll the pane's append-only event log for what the human did. Pass `since` (cursor) and optional `wait_seconds` (long-poll). |
| `send_to_pane` | Push an event into an open pane to update the live UI. |
| `update_pane` | Edit a live pane in place (ttl/title/preamble/input_data/metadata/tags/icon). |
| `upgrade_pane` | Re-pin a live pane to another version of its template (swap HTML+schemas, same URL). |
| `list_panes` | Enumerate your panes (filter by status/template_id; paginated). |
| `delete_pane` | Close/delete a pane. |
| `list_records` | List rows in a pane's mutable record collection (also the records poll/watch). |
| `get_record` | Fetch one record row by key. |
| `upsert_record` | Create/return a record row (dedups on `record_key`). |
| `update_record` | Update a record row (optional `if_match` optimistic lock). |
| `delete_record` | Soft-delete a record row (the page sees it live). |
| `delete_record_collection` | Drop a whole record collection (all rows + the collection row). Destructive, owner-only, requires `confirm: true`. |

### Consolidated tools (one tool, required `action`)

| Tool | Actions |
| --- | --- |
| `template` | `create` · `version` · `update` · `search` · `list` · `show` · `get_version` · `delete` · `publish` · `unpublish` · `search_public` · `set_icon` |
| `template_records` | `list` · `get` · `upsert` · `update` · `delete` · `delete_collection` |
| `participant` | `list` · `new` · `revoke` |
| `share` | `list` · `invite` · `set_access` · `revoke` |
| `attachments` | `upload` · `download` · `show` · `list` · `delete` · `mint_token` · `revoke_token` · `list_tokens` |
| `taste` | `get` · `set` · `clear` |
| `key` | `list` · `revoke` |
| `trash` | `list` · `restore` · `restore_template` · `purge` · `purge_template` |
| `feedback` | `create` · `list` |
| `agent` | `whoami` · `claim` · `logout` |

### Single-purpose tools

| Tool | What it does |
| --- | --- |
| `run_query` | Read-only SQL over your scoped panes/records/events (`format`: json/csv/tsv/table). |
| `get_skill` | Fetch the relay's auto-updating `SKILL.md` (unauthenticated) to self-teach the workflow. |

**Attachments** take/return file paths: `upload` reads an absolute `file_path`; `download` writes to an absolute `out_path` (or returns base64 when omitted).

**Events vs records.** Events are an append-only journal — forms, approvals, surveys, pickers. Records are a mutable collection where the current state matters more than the edit history — todo lists, kanban boards, comment threads. Reach for records when the page shows several mutable items.

### Not exposed (and why)

- The CLI's `config show` is replaced by `agent`→`whoami` (resolved relay URL + active profile + whether a key is set; no secrets).
- `agent register` isn't a tool — the server auto-registers on first use and shares the CLI's key store; `agent`→`claim` binds it to a human afterward.
- `demo` (the interactive 60-second terminal tour) and the CLI self-updater are terminal/CLI concerns with no agent use; omitted.

## Typical flow

1. `create_pane` with your HTML + an `event_schema` declaring the events the page emits → returns a `url`.
2. Paste the `url` into the conversation and ask the human to open it.
3. `get_events` with `wait_seconds: 25` in a loop, passing the prior `next_cursor` as `since`, until the awaited event appears.
4. Optionally `send_to_pane` to update the live UI, or use the record tools for mutable collections.

## MCP registry

`server.json` (in this package) carries the metadata for the [official MCP registry](https://registry.modelcontextprotocol.io). Publishing there is a follow-up step for the maintainer.

## License

MIT — see [LICENSE](./LICENSE).
