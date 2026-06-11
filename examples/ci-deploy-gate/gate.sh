#!/usr/bin/env bash
#
# ci-deploy-gate — pause a CI pipeline for a human deploy approval via a pane.
#
# Creates a pane, posts the URL (to the GitHub Actions job summary and, if
# SLACK_WEBHOOK_URL is set, to Slack), then POLLS for the human's decision with
# `pane show --wait` — the headless-friendly path for a job that can't hold a
# long-lived WebSocket. Exits 0 on approve, 1 on reject/timeout/no-response.
#
# Needs: pane CLI (npm i -g @paneui/cli), jq, and PANE_API_KEY in the env.
# Optional: PANE_URL (self-host), SLACK_WEBHOOK_URL, GATE_TIMEOUT (seconds).
#
set -euo pipefail
cd "$(dirname "$0")"

GATE_TIMEOUT="${GATE_TIMEOUT:-1800}"   # total wall-clock budget for the human
POLL_WAIT=25                            # per long-poll hold (relay caps at 30)

# --- 1. Build this run's input_data from the CI environment. ---------------
INPUT_DATA=$(jq -n \
  --arg environment "${DEPLOY_ENV:-production}" \
  --arg repo "${GITHUB_REPOSITORY:-local/example}" \
  --arg sha "${GITHUB_SHA:-unknown}" \
  --arg ref "${GITHUB_REF_NAME:-unknown}" \
  --arg actor "${GITHUB_ACTOR:-unknown}" \
  --arg run_id "${GITHUB_RUN_ID:-0}" \
  '{environment:$environment, repo:$repo, sha:$sha, ref:$ref, actor:$actor, run_id:$run_id}')

# --- 2. Create the pane. ---------------------------------------------------
CREATE=$(pane create \
  --name "Deploy gate" \
  --template ./deploy-gate.html \
  --event-schema ./deploy-gate.schema.json \
  --input-data "$INPUT_DATA" \
  --title "Approve deploy to ${DEPLOY_ENV:-production}?" \
  --ttl "$GATE_TIMEOUT" \
  --json)

PANE_ID=$(printf '%s' "$CREATE" | jq -r '.pane_id')
HUMAN_URL=$(printf '%s' "$CREATE" | jq -r '.urls.humans[0]')

echo "Created deploy-gate pane $PANE_ID"

# --- 3. Deliver the URL: job summary + optional Slack. ---------------------
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Deploy approval required"
    echo ""
    echo "A human must approve the deploy to **${DEPLOY_ENV:-production}**."
    echo ""
    echo "[Open the approval pane]($HUMAN_URL)"
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  curl -fsS -X POST "$SLACK_WEBHOOK_URL" \
    -H "content-type: application/json" \
    -d "$(jq -n --arg url "$HUMAN_URL" --arg env "${DEPLOY_ENV:-production}" \
      '{text: ("Deploy to *" + $env + "* needs approval: " + $url)}')" \
    >/dev/null || echo "warning: Slack notification failed (continuing)"
fi

echo "Waiting up to ${GATE_TIMEOUT}s for a decision…"
echo "  $HUMAN_URL"

# --- 4. Poll for the decision with `pane show --wait`. ---------------------
# Long-poll: the relay holds each call open until a new event arrives (or the
# wait elapses), and we re-call with the previous next_cursor as --since. This
# needs no persistent connection — ideal for a CI job or a FaaS step.
DEADLINE=$(( $(date +%s) + GATE_TIMEOUT ))
CURSOR=""

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -n "$CURSOR" ]; then
    SNAP=$(pane show "$PANE_ID" --since "$CURSOR" --wait "$POLL_WAIT" --json)
  else
    SNAP=$(pane show "$PANE_ID" --wait "$POLL_WAIT" --json)
  fi

  # Advance the cursor so the next poll only returns newer events.
  NEXT=$(printf '%s' "$SNAP" | jq -r '.next_cursor // empty')
  [ -n "$NEXT" ] && CURSOR="$NEXT"

  # The pane closed (TTL elapsed) before anyone decided → treat as no-response.
  if printf '%s' "$SNAP" | jq -e '.meta.status == "closed"' >/dev/null 2>&1; then
    echo "Pane closed before a decision was made — failing the gate."
    exit 1
  fi

  # Look for the terminal decision event in this batch.
  DECISION=$(printf '%s' "$SNAP" \
    | jq -r 'first(.events[] | select(.type == "deploy.decided") | .data.decision) // empty')
  if [ -n "$DECISION" ]; then
    REASON=$(printf '%s' "$SNAP" \
      | jq -r 'first(.events[] | select(.type == "deploy.decided") | .data.reason) // "(none)"')
    pane delete "$PANE_ID" >/dev/null 2>&1 || true
    if [ "$DECISION" = "approve" ]; then
      echo "Approved — proceeding with the deploy."
      exit 0
    else
      echo "Rejected — reason: $REASON"
      exit 1
    fi
  fi
done

echo "Timed out after ${GATE_TIMEOUT}s with no decision — failing the gate."
pane delete "$PANE_ID" >/dev/null 2>&1 || true
exit 1
