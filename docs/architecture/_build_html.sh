#!/usr/bin/env bash
# Renders the v1 architecture docs into a single styled HTML page (for review on phone/Telegram).
# Usage: docs/architecture/_build_html.sh [output.html]
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root
OUT="${1:-/tmp/pane-v1-architecture.html}"
DOCS="docs/architecture"

frag() { pandoc -f gfm -t html "$1"; }

# Phase 0 summary (the SPEC/ROADMAP delta) as inline markdown:
PHASE0_MD=$(cat <<'MD'
## Phase 0: design decisions folded into docs/SPEC.md + docs/ROADMAP.md (done)

The v1 design, now reflected in `docs/SPEC.md`, `docs/ROADMAP.md`, and the phase docs:

- **Events are the only primitive on the wire.** No separate `emit` / `submit` verbs. State is what you get by replaying events. The agent that creates the session bundles the rendered artifact AND a per-session event schema; the relay validates every write against that schema.
- **Four-table data model**: `agents`, `sessions`, `participants`, `events`. The `participants` table is new (per-identity tokens with `kind: "human" | "agent"`). The `events` table carries `author_kind`, `author_id`, `causation_id`, `idempotency_key`; a unique constraint on `(session_id, author_id, idempotency_key)` does dedup.
- **Identity stamped server-side.** Clients cannot spoof `author`. The relay resolves the bearer token to a participant (or agent) and writes `author` onto every accepted event.
- **WebSocket primary, HTTP fallback.** `WS /v1/sessions/:id/stream` is bidirectional with replay-on-connect; `POST|GET /v1/sessions/:id/events` (long-poll) remains for stateless agents.
- **Schema validation at the relay.** Per-session `eventSchema.events` declares typed events with payload JSON Schemas and `emittedBy: ["page" | "agent"]`. Ajv validates every `data` against the type's payload schema; the relay rejects writes outside the declared vocabulary.
- **Sandbox: `allow-scripts` only** (no `allow-same-origin`, no forms, no top-nav). CSP `connect-src 'none'` on the artifact content. The artifact's only channel out is `postMessage` to the shell.
- **MCP server**: three tools in v1. `create_pane_session(artifact, schema)`, `await_pane_result(session_id, terminal_event_type)`, `get_pane_state(session_id)`. No magic "submit" verb; the agent names the terminal event type.
- **`/v1/register`** creates an `agents` row (returns the raw key once), open by default and bounded by a per-IP rate limiter. **`/v1/keys`** lists/revokes the calling agent's own row. The `API_KEY` env var upserts a `default` agent on boot, so the env key and DB-issued keys share one validation path.
- **`events.id` is `BIGINT`**, doubles as the opaque poll cursor (a string on the wire), so the underlying type can change later (e.g. to a ULID for a sharded hosted build) without breaking clients.
- **Webhook callbacks** are best-effort with HMAC signing in v1 (durable delivery is `/ee/`).
MD
)
PHASE0_HTML=$(echo "$PHASE0_MD" | pandoc -f gfm -t html)

README_HTML=$(frag "$DOCS/README.md")
P1=$(frag "$DOCS/phase-1-skeleton-and-data.md")
P2=$(frag "$DOCS/phase-2-relay-api.md")
P3=$(frag "$DOCS/phase-3-human-side.md")
P4=$(frag "$DOCS/phase-4-mcp-ttl-deploy.md")

cat > "$OUT" <<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pane: v1 Architecture</title>
<style>
  :root{
    --bg:#0B0E14; --bg2:#11151F; --bg3:#161B26;
    --fg:#D7DEE9; --muted:#8A93A6; --dim:#5B6477;
    --accent:#4DA3FF; --accent2:#7CE3B1; --warn:#FFB454; --pink:#F07178;
    --border:#1F2633; --code-bg:#0D1119;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{-webkit-text-size-adjust:100%}
  body{
    background:var(--bg); color:var(--fg);
    font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    padding:26px 18px 90px; max-width:920px; margin:0 auto;
    animation:fade .4s ease-out;
  }
  @keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  h1{font-size:27px;line-height:1.22;margin:2px 0 4px;letter-spacing:-.01em}
  .lead{color:var(--muted);font-size:14.5px;margin-bottom:8px}
  h2{font-size:21px;margin:38px 0 10px;padding-top:20px;border-top:1px solid var(--border);letter-spacing:-.01em}
  h3{font-size:17px;margin:24px 0 8px;color:var(--accent)}
  h4{font-size:14px;margin:18px 0 6px;color:var(--accent2);text-transform:uppercase;letter-spacing:.07em}
  p{margin:10px 0}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  code{font-family:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace;
    font-size:.86em;background:var(--bg3);padding:1.5px 5px;border-radius:4px;color:var(--accent2)}
  pre{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:14px 13px;
    overflow-x:auto;margin:13px 0;font-family:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace;
    font-size:12.5px;line-height:1.6;color:#C3CBD9}
  pre code{background:none;padding:0;color:inherit;font-size:inherit}
  ul,ol{margin:10px 0 10px 22px}
  li{margin:6px 0}
  li::marker{color:var(--accent)}
  strong{color:#EAF0F8}
  em{color:var(--muted)}
  table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13.5px;display:block;overflow-x:auto}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
  td code{font-size:.92em}
  blockquote{border-left:3px solid var(--warn);background:rgba(255,180,84,.06);padding:8px 14px;margin:14px 0;color:var(--fg);border-radius:0 8px 8px 0}
  hr{border:none;border-top:1px solid var(--border);margin:26px 0}
  .toc{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin:20px 0 8px}
  .toc h4{margin-top:0}
  .toc ol{margin-left:20px}
  .toc a{font-size:14.5px}
  .doc{margin-top:8px}
  .note{color:var(--dim);font-size:12.5px;margin-top:4px}
  footer{margin-top:46px;padding-top:16px;border-top:1px solid var(--border);color:var(--dim);font-size:12.5px}
  /* keyword-ish coloring for fenced blocks is left to pandoc's defaults (none); kept monochrome on purpose */
</style>
</head>
<body>

<h1>Pane: v1 Architecture</h1>
<div class="lead">Per-phase build/architecture docs for Pane v1. Source: <code>docs/architecture/</code>, with <code>docs/SPEC.md</code> + <code>docs/ROADMAP.md</code> as the system-level companions. OPEN = decide during implementation; DECIDED = settled.</div>

<div class="toc">
<h4>Contents</h4>
<ol>
  <li><a href="#overview">Overview, how these docs are laid out</a></li>
  <li><a href="#phase0">Phase 0: design decisions (done)</a></li>
  <li><a href="#phase1">Phase 1: Skeleton + data layer</a></li>
  <li><a href="#phase2">Phase 2: The relay API</a></li>
  <li><a href="#phase3">Phase 3: The human side (shell, iframe, bridge)</a></li>
  <li><a href="#phase4">Phase 4: TTL sweeper, MCP server, deploy, dogfood</a></li>
</ol>
</div>

<div class="doc" id="overview">$README_HTML</div>
<h2 id="phase0">Phase 0</h2>
<div class="doc">$PHASE0_HTML</div>
<h2 id="phase1">Phase 1: Skeleton + data layer</h2>
<div class="doc">$P1</div>
<h2 id="phase2">Phase 2: The relay API</h2>
<div class="doc">$P2</div>
<h2 id="phase3">Phase 3: The human side</h2>
<div class="doc">$P3</div>
<h2 id="phase4">Phase 4: TTL sweeper, MCP, deploy, dogfood</h2>
<div class="doc">$P4</div>

<footer>Pane: design docs · generated $(date +%Y-%m-%d) · Lalit Singh · linkedin.com/in/0xlalit</footer>

</body>
</html>
HTML

echo "wrote $OUT"
