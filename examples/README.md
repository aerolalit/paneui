# Pane examples

Three small, runnable examples of the pane round trip — an agent hands a human a
rich UI by URL and gets structured data back. Each lives in its own directory
with its own README.

| Example | Agent kind | How the URL reaches the human | How the answer comes back |
|---|---|---|---|
| [`claude-code-approval/`](claude-code-approval/) | CLI agent (Claude Code, Codex, any shell agent) | Printed to the terminal | `pane watch` (CLI) |
| [`telegram-bot-approval/`](telegram-bot-approval/) | Telegram bot (Node/TypeScript) | Sent as a Telegram DM | `openStream` / `@paneui/core` |
| [`ci-deploy-gate/`](ci-deploy-gate/) | GitHub Actions job | Posted to the job summary (+ optional Slack webhook) | `pane show --wait` polling |

All three use the same model: author (or reuse) an HTML template, create a pane,
deliver `urls.humans[0]` over whatever channel you already have, then wait for
the human's terminal event. The only thing that changes is the delivery channel
and how the agent waits.

## Prerequisites

- **Node 20+**.
- The `pane` CLI for the CLI/CI examples: `npm i -g @paneui/cli`.
- A registered agent key against a relay. The hosted relay is the default:

  ```sh
  pane agent register --name "my-agent"   # writes ~/.config/pane/config.json
  ```

  Self-hosters set `PANE_URL` (and `PANE_API_KEY`) to point at their own relay.

These examples are intentionally **not** part of the pane npm workspace — the
root `package.json` only globs `packages/*`. Each example that needs deps has
its own standalone, `private` `package.json`, so `npm install` here doesn't
touch the monorepo build.

> The pane CLI is self-documenting — `pane <command> --help` is always the
> authoritative reference for flags and defaults. The
> [agent skill](../skills/pane/SKILL.md) is the full reference for the
> template/pane model, schemas, records, and attachments.
