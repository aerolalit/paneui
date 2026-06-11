#!/usr/bin/env bash
#
# claude-code-approval — hand a human an "approve this plan?" pane from a CLI
# agent, then read the decision back. This is exactly the sequence a shell
# agent (Claude Code, Codex, etc.) runs; nothing here is agent-specific.
#
# Prereqs:
#   npm i -g @paneui/cli
#   pane agent register --name "my-agent"   # one-time
#
# Usage:
#   ./run.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# 1) Create the pane. Inline the one-off template + event schema, and seed this
#    instance's plan via --input-data (the page reads it as window.pane.inputData).
#    --json forces machine-readable output so we can parse it; the CLI also emits
#    JSON automatically when stdout is piped.
CREATE=$(pane create \
  --name "Plan approval" \
  --template ./plan-approval.html \
  --event-schema ./plan-approval.schema.json \
  --input-data ./input-data.example.json \
  --title "Approve this plan?" \
  --ttl 1800 \
  --json)

PANE_ID=$(printf '%s' "$CREATE" | jq -r '.pane_id')
HUMAN_URL=$(printf '%s' "$CREATE" | jq -r '.urls.humans[0]')

echo "Pane created: $PANE_ID"
echo
echo "  Open this URL to decide:"
echo "  $HUMAN_URL"
echo

# 2) Block until the human clicks Approve or Reject. `pane watch --type` exits 0
#    the moment a matching event lands; --timeout caps how long we wait for the
#    human (here: 30 min, matching the pane TTL).
echo "Waiting for a decision (Ctrl-C to stop)…"
EVENT=$(pane watch "$PANE_ID" --type plan.decided --timeout 1800)

# 3) Act on the structured result. The terminal event arrives as a single JSON
#    line; the human's answer is in .data.
DECISION=$(printf '%s' "$EVENT" | jq -r '.data.decision')
REASON=$(printf '%s' "$EVENT" | jq -r '.data.reason // "(no reason given)"')

echo
echo "Decision: $DECISION"
echo "Reason:   $REASON"

# 4) Clean up the pane (optional — it would expire on its own at TTL).
pane delete "$PANE_ID" >/dev/null

if [ "$DECISION" = "approve" ]; then
  echo "→ proceeding."
  exit 0
else
  echo "→ halting."
  exit 1
fi
