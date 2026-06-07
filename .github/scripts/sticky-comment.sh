#!/usr/bin/env bash
#
# sticky-comment.sh <pr-number> <body>
#
# Upsert a single "sticky" comment on a PR, identified by the HTML marker on
# the first line of <body> (e.g. `<!-- pane-pr-preview -->`). If a comment with
# that marker already exists it's edited in place; otherwise a new one is
# created. Keeps the PR to one preview comment that updates across pushes
# instead of spamming a new comment each time.
#
# Requires: gh authenticated (GH_TOKEN in CI), jq.

set -euo pipefail

PR="${1:?usage: sticky-comment.sh <pr-number> <body>}"
BODY="${2:?usage: sticky-comment.sh <pr-number> <body>}"
REPO="${GITHUB_REPOSITORY:-aerolalit/paneui}"

# Marker = first HTML comment on the first line of the body.
MARKER=$(printf '%s\n' "$BODY" | head -1 | grep -oE '<!--[^>]*-->' || true)
if [ -z "$MARKER" ]; then
  echo "error: body must start with an HTML marker comment, e.g. <!-- pane-pr-preview -->" >&2
  exit 2
fi

# Find an existing comment carrying the marker.
EXISTING_ID=$(gh api "repos/${REPO}/issues/${PR}/comments" --paginate \
  --jq "map(select(.body | contains(\"${MARKER}\"))) | .[0].id // empty" 2>/dev/null || true)

if [ -n "$EXISTING_ID" ]; then
  gh api -X PATCH "repos/${REPO}/issues/comments/${EXISTING_ID}" \
    -f body="$BODY" >/dev/null
  echo "→ updated sticky comment ${EXISTING_ID}"
else
  gh api -X POST "repos/${REPO}/issues/${PR}/comments" \
    -f body="$BODY" >/dev/null
  echo "→ created sticky comment"
fi
