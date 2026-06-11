# ci-deploy-gate

Pause a CI pipeline for a **human deploy approval** delivered as a pane URL. The
pipeline has no GUI and the approver is somewhere else entirely (Slack, the run's
job summary on their phone) — the out-of-band case pane is built for. A human
approves or rejects with a reason; the gate script polls the result and exits
`0` (proceed) or `1` (stop), which gates the downstream `deploy` job.

Unlike the CLI and Telegram examples, this one **polls** with `pane show --wait`
instead of holding a WebSocket — a CI step can't keep a long-lived connection
open, so it long-polls the relay and re-calls with the previous cursor.

## What's here

| File | Purpose |
|---|---|
| `deploy.yml` | Example GitHub Actions workflow: a `gate` job that blocks on approval, then a `deploy` job gated on it. |
| `gate.sh` | The gate script: create the pane → post the URL (job summary + optional Slack) → poll for the decision → exit `0`/`1`. |
| `deploy-gate.html` | The pane UI — deploy details, Approve / Reject (reject requires a reason). |
| `deploy-gate.schema.json` | The event schema — one page event, `deploy.decided`. |

## How it works

`gate.sh`:

1. **Builds `input_data`** from the CI environment (`GITHUB_REPOSITORY`,
   `GITHUB_SHA`, `DEPLOY_ENV`, …) so the pane shows what's being deployed.
2. **Creates the pane**:

   ```sh
   pane create \
     --name "Deploy gate" \
     --template ./deploy-gate.html \
     --event-schema ./deploy-gate.schema.json \
     --input-data "$INPUT_DATA" \
     --title "Approve deploy to $DEPLOY_ENV?" \
     --ttl "$GATE_TIMEOUT" \
     --json
   ```
3. **Delivers `urls.humans[0]`** to the GitHub Actions job summary (a clickable
   link on the run page) and, if `SLACK_WEBHOOK_URL` is set, to Slack.
4. **Polls for the decision** with the headless long-poll, advancing the cursor
   each round so it only ever sees new events:

   ```sh
   pane show "$PANE_ID" --wait 25 --json                 # first poll
   pane show "$PANE_ID" --since "$CURSOR" --wait 25 --json   # subsequent polls
   ```

   The relay holds each call open until an event arrives (capped at 30s), so
   this is cheap — no persistent connection, no busy loop.
5. **Exits** `0` on `approve`, `1` on `reject`, and `1` on timeout or if the
   pane closes (TTL elapsed) with no decision. In the workflow, `deploy` has
   `needs: gate`, so a non-zero gate stops the deploy.

## Try it locally

You can run the gate outside CI to see the round trip. In one terminal:

```sh
cd examples/ci-deploy-gate
export PANE_API_KEY="pane_your_agent_key"
DEPLOY_ENV=staging GATE_TIMEOUT=300 ./gate.sh
```

It prints a pane URL. Open it, approve or reject — the script prints the outcome
and exits `0`/`1` (`echo $?` to check).

## Wire it into GitHub Actions

Copy `deploy.yml` to `.github/workflows/` in your repo (and `gate.sh` +
`deploy-gate.html` + `deploy-gate.schema.json` to wherever the workflow's `run:`
points). Add two repo secrets:

- **`PANE_API_KEY`** — a pane agent key (`pane agent register --print-key`).
- **`SLACK_WEBHOOK_URL`** *(optional)* — an incoming-webhook URL to also notify
  Slack.

Self-hosters set `PANE_URL` to point the CLI at their own relay.

> Requirements on the runner: the `pane` CLI (`npm i -g @paneui/cli`) and `jq`
> (preinstalled on `ubuntu-latest`).
