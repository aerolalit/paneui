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

## Try it

Register once, then `pane demo` spins up a short-lived sample pane on the hosted
relay, opens it in your browser, and prints the structured event back in your
terminal the moment you interact (the demo pane is cleaned up on exit):

```sh
npx @paneui/cli agent register --name "my-agent"   # one-time, hosted relay
npx @paneui/cli demo                               # Node 20+ — round-trip in ~60s
```

Add `--no-open` on a headless / SSH box and it just prints the URL.

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
pane demo                      Zero-setup guided tour — see the round-trip live
pane agent register            Provision an agent API key and save it locally
pane agent logout              Clear the locally-saved URL + API key
pane create            Create a pane — returns pane_id, urls, tokens
pane show <id>         Non-blocking snapshot: metadata + event log
pane send <id>         Emit an agent event into a pane
pane watch <id>        Stream a pane's events as JSON-lines on stdout
pane delete <id>       Close / delete a pane
pane template <verb>           Manage reusable, versioned templates
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
SESSION=$(pane create --template ./form.html --name "Quick poll" --event-schema ./q.json | jq -r .pane_id)
pane watch "$SESSION" | jq 'select(.type == "human_response")'
```

## Links

- Repo: <https://github.com/aerolalit/paneui>
- Spec: <https://github.com/aerolalit/paneui/blob/main/docs/SPEC.md>
- License: MIT
