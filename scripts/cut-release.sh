#!/usr/bin/env bash
#
# cut-release.sh — prepare a paneui release-prep commit.
#
# Bumps every place a version lives, regenerates the lockfile, runs a smoke
# build (which catches the workspace-link breakage class that bit v0.0.6),
# and lands a release-prep commit on a `chore/release-v<version>` branch.
# Stops before pushing so you can review the diff. Pass --push to also
# push the branch and open the PR.
#
# Usage:
#   ./scripts/cut-release.sh 0.0.7
#   ./scripts/cut-release.sh 0.0.7 --push
#
# What it bumps:
#   - "version" in root package.json
#   - "version" in packages/{cli,core,mcp,relay}/package.json
#   - "@paneui/core" dependency in packages/{cli,mcp,relay}/package.json
#     (caret-pins to the new ^X.Y.Z so npm-workspaces keeps linking the
#      local copy instead of resolving an older version from npm)
#   - VERSION constant in packages/cli/src/version.ts
#   - "<!-- pane skill v... -->" comment in skills/pane/SKILL.md
#
# After PR merges, tag and push manually:
#   git fetch origin main
#   git tag v<version> <merge-commit-sha>
#   git push origin v<version>
#
# The tag push triggers release-image (GHCR build), release (npm publish +
# landing-page deploy + GitHub Release) and — once the -postgres image is
# built — an automatic prod relay rollout (deploy-prod-relay → paneui-ops).
#
# Why this script exists: v0.0.6 was prepared by hand and missed the
# @paneui/core dep bump in @paneui/relay, which broke the workspace build
# at tag-cut time. This script makes that mistake structurally impossible.

set -euo pipefail

# ---- Inputs ------------------------------------------------------------

if [ $# -lt 1 ]; then
  echo "usage: $0 <version> [--push]" >&2
  echo "e.g.:  $0 0.0.7"               >&2
  echo "       $0 0.0.7 --push"        >&2
  exit 2
fi

VERSION="$1"
PUSH=0
shift || true
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --*)    echo "error: unknown flag $arg" >&2; exit 2 ;;
    *)      echo "error: unexpected positional arg $arg" >&2; exit 2 ;;
  esac
done

# Plain semver — major.minor.patch with optional pre-release tail.
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "error: '$VERSION' is not a plain semver (e.g. 0.0.7, 0.1.0-rc1)" >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

# ---- Pre-flight --------------------------------------------------------

# Clean working tree — we don't want unrelated work mixed into the release
# commit, and a failed build mid-run shouldn't leave a half-applied bump
# without an obvious git state to recover from.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree has uncommitted changes — commit, stash, or" >&2
  echo "       discard them first." >&2
  git status --short >&2
  exit 1
fi

CURRENT_VERSION=$(jq -r .version package.json)
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  echo "error: package.json is already at $VERSION — nothing to bump" >&2
  exit 1
fi

BRANCH="chore/release-v${VERSION}"
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "error: branch $BRANCH already exists locally — delete it first or" >&2
  echo "       pick a different version" >&2
  exit 1
fi

echo "→ cutting release v$VERSION (from $CURRENT_VERSION)"
echo "  branch: $BRANCH"
echo ""

# Create the branch first so any subsequent failure leaves a clear
# 'git checkout main && git branch -D <branch>' recovery path.
git checkout -b "$BRANCH" >/dev/null

# Trap: if we fail before commit, undo the bumps and delete the branch so
# the user is back where they started.
ROLLBACK_ON_FAIL=1
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$ROLLBACK_ON_FAIL" -eq 1 ]; then
    echo "" >&2
    echo "→ cleaning up (release-prep failed)" >&2
    git restore --staged --worktree -- . >/dev/null 2>&1 || true
    git checkout main >/dev/null 2>&1 || true
    git branch -D "$BRANCH" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---- Bump --------------------------------------------------------------

echo "→ bumping versions"
for f in package.json packages/cli/package.json packages/core/package.json packages/mcp/package.json packages/relay/package.json; do
  tmp=$(mktemp)
  jq --arg v "$VERSION" '.version = $v' "$f" > "$tmp" && mv "$tmp" "$f"
  echo "  $f"
done

# Bump every internal @paneui/* dep in every package that depends on it
# (today: @paneui/core in cli + mcp + relay; @paneui/mcp in relay). Caret-
# pinning to the new version is what makes npm-workspaces keep linking the
# local copy at build time — without this, the workspace falls back to the
# older published version from npm and the build/runtime fails with "no
# exported member …" or "Cannot find module …/tools" for anything added
# since the last release. Caret on 0.0.x is patch-locked, so the dep range
# MUST move in lockstep with the version bump.
for f in packages/cli/package.json packages/mcp/package.json packages/relay/package.json; do
  for dep in "@paneui/core" "@paneui/mcp"; do
    if jq -e --arg d "$dep" '.dependencies[$d]' "$f" >/dev/null; then
      tmp=$(mktemp)
      jq --arg d "$dep" --arg v "^$VERSION" '.dependencies[$d] = $v' "$f" > "$tmp" && mv "$tmp" "$f"
      echo "  $f ($dep dep → ^$VERSION)"
    fi
  done
done

# Runtime VERSION constant — what `pane --version` prints.
VERSION_TS="packages/cli/src/version.ts"
sed -i.bak "s/export const VERSION = \".*\";/export const VERSION = \"$VERSION\";/" "$VERSION_TS"
rm "${VERSION_TS}.bak"
echo "  $VERSION_TS (VERSION constant)"

# Runtime VERSION constant — reported in the MCP server's serverInfo
# (and seen by an MCP client's `initialize`).
MCP_VERSION_TS="packages/mcp/src/version.ts"
sed -i.bak "s/export const VERSION = \".*\";/export const VERSION = \"$VERSION\";/" "$MCP_VERSION_TS"
rm "${MCP_VERSION_TS}.bak"
echo "  $MCP_VERSION_TS (VERSION constant)"

# MCP registry manifest — both the top-level `version` and the npm
# package's `version` must match the published @paneui/mcp version, or
# the registry rejects the submission as inconsistent with npm.
MCP_SERVER_JSON="packages/mcp/server.json"
tmp=$(mktemp)
jq --arg v "$VERSION" '.version = $v | .packages[].version = $v' "$MCP_SERVER_JSON" > "$tmp" && mv "$tmp" "$MCP_SERVER_JSON"
echo "  $MCP_SERVER_JSON (version + packages[].version)"

# Skill version comment — the `<!-- pane skill vX.Y.Z -->` line in SKILL.md.
# Kept in lockstep with the package version (see the "Keeping this skill up
# to date" section of SKILL.md). The relay reads this comment at boot and
# serves it from GET /skills/pane/SKILL.md/version; an agent's stale-skill
# probe compares its local copy to the relay's.
SKILL_MD="skills/pane/SKILL.md"
sed -i.bak "s|<!-- pane skill v[0-9][^ ]* -->|<!-- pane skill v${VERSION} -->|" "$SKILL_MD"
rm "${SKILL_MD}.bak"
echo "  $SKILL_MD (skill version comment)"

# The MCP invocation layer carries the same version comment so the composed
# MCP guide (MCP-INVOCATION.md + the core blocks of SKILL.md) reports one
# version in lockstep with SKILL.md. The relay reads SKILL.md's comment for the
# MCP.md/version probe, but bumping both keeps the source files consistent.
MCP_INVOCATION_MD="skills/pane/MCP-INVOCATION.md"
sed -i.bak "s|<!-- pane skill v[0-9][^ ]* -->|<!-- pane skill v${VERSION} -->|" "$MCP_INVOCATION_MD"
rm "${MCP_INVOCATION_MD}.bak"
echo "  $MCP_INVOCATION_MD (skill version comment)"

# ---- Refresh lockfile + workspace symlinks -----------------------------

echo ""
echo "→ running npm install (refreshes lockfile + relinks workspaces)"
npm install --silent

# ---- Smoke build (the bit that catches a missed dep bump) --------------

echo ""
echo "→ running npm run build (smoke check)"
if ! npm run build --silent; then
  echo "" >&2
  echo "error: build failed — release-prep cannot proceed" >&2
  echo "" >&2
  echo "  Most likely cause: a @paneui/core dep in some package.json was not" >&2
  echo "  bumped, so the workspace symlink to the new local copy didn't form" >&2
  echo "  and the build resolved against the older npm-published version." >&2
  echo "  Inspect:" >&2
  echo "    grep -r '\"@paneui/' packages/*/package.json" >&2
  exit 1
fi

# ---- Commit ------------------------------------------------------------

echo ""
echo "→ committing release-prep"
git add package.json package-lock.json \
  packages/cli/package.json packages/cli/src/version.ts \
  packages/core/package.json \
  packages/mcp/package.json packages/mcp/src/version.ts packages/mcp/server.json \
  packages/relay/package.json \
  skills/pane/SKILL.md skills/pane/MCP-INVOCATION.md
git commit -q -m "chore(release): v${VERSION}

Bump @paneui/core, @paneui/cli, @paneui/mcp, @paneui/relay and root to
${VERSION}.
Bump VERSION constant in packages/cli/src/version.ts and
packages/mcp/src/version.ts to match, plus the version + packages[].version
in packages/mcp/server.json so the MCP registry manifest matches the
published npm version.
Bump internal @paneui/core dependency in @paneui/cli, @paneui/mcp and
@paneui/relay to ^${VERSION} so workspace linking finds the local copy
at build time.
Bump <!-- pane skill v... --> comment in skills/pane/SKILL.md so the
relay's GET /skills/pane/SKILL.md/version probe matches the release."

# Past this point we don't want the trap to rollback — we have a commit.
ROLLBACK_ON_FAIL=0

# ---- Done --------------------------------------------------------------

cat <<EOF

═══════════════════════════════════════════════════════════════════════
 ✓ release-prep commit ready on $BRANCH
═══════════════════════════════════════════════════════════════════════

  Review the diff:
    git -C $REPO_ROOT show

  Push and open PR (if --push wasn't given):
    git -C $REPO_ROOT push -u origin $BRANCH
    gh pr create --fill --base main

  After PR merges, tag and push:
    git -C $REPO_ROOT fetch origin main
    git -C $REPO_ROOT tag v${VERSION} <merge-commit-sha>
    git -C $REPO_ROOT push origin v${VERSION}

  The tag push triggers (all automatic — no further button presses):
    - release-image  → builds ghcr.io/aerolalit/paneui:${VERSION} + :${VERSION}-postgres,
                       then dispatches deploy-prod-relay → paneui-ops rolls the
                       prod relay (ca-eur-prod-pane) to :${VERSION}-postgres
    - release        → publishes @paneui/core@${VERSION} + @paneui/cli@${VERSION} + @paneui/mcp@${VERSION} to npm,
                       redeploys the landing page (paneui.com) and cuts a GitHub Release

  Prod relay rollback stays manual: dispatch paneui-ops relay-deploy with the
  previous version.
EOF

# ---- Optional auto-push ------------------------------------------------

if [ "$PUSH" -eq 1 ]; then
  echo ""
  echo "→ --push given, pushing branch"
  git push -u origin "$BRANCH"
  echo ""
  echo "→ opening PR"
  gh pr create --base main --fill || {
    echo "warn: gh pr create failed — push succeeded; open PR manually" >&2
  }
fi
