# @paneui/cli

Command-line client for the [Pane](https://github.com/aerolalit/paneui) relay:
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
pane agent register --name "my-agent"            # provisions and saves an API key
```

`pane agent register` writes the URL + API key to
`${XDG_CONFIG_HOME:-~/.config}/pane/config.json`. Subsequent commands need
only `PANE_URL` (or nothing) in the environment.

Override per-invocation with `--url <url>` and `--api-key <key>`.

## Commands

Uniform `pane <noun> <verb> [options]`:

```
pane agent register            Provision an agent API key and save it locally
pane agent logout              Clear the locally-saved URL + API key
pane session create            Create a session — returns session_id, urls, tokens
pane session show <id>         Non-blocking snapshot: metadata + event log
pane session send <id>         Emit an agent event into a session
pane session watch <id>        Stream a session's events as JSON-lines on stdout
pane session delete <id>       Close / delete a session
pane artifact <verb>           Manage reusable, versioned artifacts
pane key list | revoke         Inspect or revoke your agent's API key
pane taste get | set | clear   Read / write / clear UI-taste notes
pane feedback create | list    Submit / list one-shot feedback to the operator
pane config show               Show the resolved relay config (no network call)
pane skill show | version      Fetch the relay's SKILL.md (or its version)
```

Run `pane <noun> --help` for that noun's verbs, and
`pane <noun> <verb> --help` for verb-specific options.

## Output

stdout is machine-readable JSON. Errors go to stderr as
`{"error":{"code","message"}}` with a non-zero exit.

```sh
SESSION=$(pane session create --template form --schema ./q.json | jq -r .session_id)
pane session watch "$SESSION" | jq 'select(.type == "human_response")'
```

## Links

- Repo: <https://github.com/aerolalit/paneui>
- Spec: <https://github.com/aerolalit/paneui/blob/main/docs/SPEC.md>
- License: MIT
