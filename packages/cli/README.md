# @paneui/cli

Command-line client for the [Pane](https://github.com/aerolalit/pane) relay:
hand a human a rich interactive UI by URL and capture their answer as structured
data — from any agent (cron job, chat bot, CI, headless server).

## Install

```sh
npm install -g @paneui/cli
# or, no install:
npx @paneui/cli <command>
```

The binary is `pane`.

## Setup

```sh
export PANE_URL=https://relay.paneui.com   # or your self-hosted relay
pane register --name "my-agent"            # provisions and saves an API key
```

`pane register` writes the URL + API key to
`${XDG_CONFIG_HOME:-~/.config}/pane/config.json`. Subsequent commands need
only `PANE_URL` (or nothing) in the environment.

Override per-invocation with `--url <url>` and `--api-key <key>`.

## Commands

```
pane register          Provision an agent API key and save it locally
pane create            Create a session — returns session_id, urls, tokens
pane artifact          Manage reusable, versioned artifacts
pane state <id>        Non-blocking snapshot: metadata + event log
pane send <id>         Emit an agent event into a session
pane watch <id>        Stream a session's events as JSON-lines on stdout
pane delete <id>       Close / delete a session
pane keys              Inspect or revoke your agent's API key
pane config            Show the resolved relay config (no network call)
pane logout            Clear the locally-saved URL + API key
```

Run `pane <command> --help` for command-specific options.

## Output

stdout is machine-readable JSON. Errors go to stderr as
`{"error":{"code","message"}}` with a non-zero exit.

```sh
SESSION=$(pane create --template form --schema ./q.json | jq -r .session_id)
pane watch "$SESSION" | jq 'select(.type == "human_response")'
```

## Links

- Repo: <https://github.com/aerolalit/pane>
- Spec: <https://github.com/aerolalit/pane/blob/main/docs/SPEC.md>
- License: MIT
