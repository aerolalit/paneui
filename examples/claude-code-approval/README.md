# claude-code-approval

Hand a human an **"approve this plan?"** pane from a CLI agent (Claude Code,
Codex, or any agent that can run a shell command), then read the decision back
as structured data. This is the simplest possible pane round trip: no bot, no
front-end app — just the `pane` CLI.

## What's here

| File | Purpose |
|---|---|
| `plan-approval.html` | The pane UI — a plan summary, Approve/Reject buttons, an optional note. Reads its per-instance plan from `window.pane.inputData`. |
| `plan-approval.schema.json` | The event schema. Declares one page event, `plan.decided`, with `decision` (`approve`/`reject`) and an optional `reason`. |
| `input-data.example.json` | Example seed data for one plan — title, summary, and steps. |
| `run.sh` | The end-to-end script: create → print URL → `pane watch` → act on the result. |

## Run it

```sh
npm i -g @paneui/cli            # if you haven't
pane agent register --name "my-agent"   # one-time; uses the hosted relay
./run.sh
```

`run.sh` needs `jq` to parse the JSON. The script prints a URL, blocks on
`pane watch`, and exits `0` on approve / `1` on reject.

## The commands an agent actually runs

**1. Create the pane** — inline the one-off template + schema, seed the plan
with `--input-data`:

```sh
pane create \
  --name "Plan approval" \
  --template ./plan-approval.html \
  --event-schema ./plan-approval.schema.json \
  --input-data ./input-data.example.json \
  --title "Approve this plan?" \
  --ttl 1800 \
  --json
```

That returns (trimmed):

```json
{
  "pane_id": "pan_Niam6cGkg3Q9us8U",
  "urls": {
    "humans": ["https://relay.paneui.com/s/tok_h_3a-okMzK…"],
    "agent_stream": "wss://relay.paneui.com/v1/panes/pan_Niam6cGkg3Q9us8U/stream"
  },
  "tokens": { "humans": ["tok_h_…"], "agent": "tok_a_…" },
  "expires_at": "2026-06-11T09:02:15.177Z",
  "title": "Approve this plan?"
}
```

Deliver `urls.humans[0]` to the human — here, just print it to the terminal.

**2. Wait for the decision** — `pane watch --type` blocks until the human clicks
Approve or Reject, then exits `0`:

```sh
pane watch pan_Niam6cGkg3Q9us8U --type plan.decided --timeout 1800
```

When the human approves, watch prints one JSON line (its `data` is the human's
answer) and exits:

```json
{
  "id": "2601",
  "pane_id": "pan_Niam6cGkg3Q9us8U",
  "author": { "kind": "human", "id": "h_0" },
  "ts": "2026-06-11T08:59:…Z",
  "type": "plan.decided",
  "data": { "decision": "approve", "reason": "ship it" }
}
```

If the pane expires before the human acts, watch prints a final
`{"type":"_closed"}` line and exits `0` — treat that as "no response", not as a
decision. If `--timeout` elapses first, watch writes
`{"error":{"code":"ws_timeout"}}` to stderr and exits non-zero.

## Reusing the template

This example inlines the HTML on every `create`. If you'll approve plans
repeatedly, register the template **once** and instance it by slug — no HTML
re-sent:

```sh
pane template create \
  --name "Plan approval" --slug plan-approval \
  --description "Approve/reject a plan. input_data: {title, summary, steps[]}" \
  --tags approval,plan \
  --template ./plan-approval.html \
  --event-schema ./plan-approval.schema.json

# then, per plan:
pane create --template-id plan-approval --input-data ./input-data.example.json
```

See the [agent skill](../../skills/pane/SKILL.md) ("Search before you generate")
for why reuse beats regeneration.
