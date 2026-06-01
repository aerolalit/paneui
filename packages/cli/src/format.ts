// Human-readable formatter for `pane surface create` output.
//
// The CLI is JSON-first — that's how agents call it. But humans run it too:
// the agent dev iterating on a template, the operator smoke-testing a relay,
// the developer who fires `pane create` once a day to grab a URL and hand
// it to themselves on their phone. Dumping `{ surface_id, urls, tokens, ... }`
// at them is a downgrade in every case where the next step is "open the
// URL in a browser".
//
// In a TTY (and without `--json` on the CLI), this module renders:
//   - the title prominently
//   - each human URL on its own line, copy-friendly
//   - a QR code for the first human URL, scannable from a phone
//   - the expiry as a countdown ("in 1h 0m") + ISO timestamp
//   - the agent stream URL on a dim line (less important for humans)
//
// Trust boundary: every interpolated value is a server response or a string
// the caller asked us to render. No HTML escaping needed — terminal output.
// We DO neutralise stray ANSI escape characters (a malicious title could
// otherwise inject colour codes); see stripAnsi.

import qrcode from "qrcode-terminal";

/**
 * The interesting subset of CreateSessionResponse this module formats.
 * Typed locally (vs. re-importing from @paneui/core) so the formatter
 * keeps working if peripheral fields evolve — only these few are load-bearing.
 */
export interface SurfaceCreatedView {
  surface_id: string;
  created?: boolean;
  title: string;
  expires_at: string;
  urls: {
    humans: string[];
    agent_stream: string;
  };
  context_key?: string | null;
}

/** ANSI helpers. Only applied when writing to a TTY; harmless characters
 *  otherwise. We deliberately don't pull in a colour library — the CLI has
 *  one runtime dep today (qrcode-terminal) and we'd like to keep the
 *  surface area tight. */
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

// Strip control chars from interpolated strings. Defends against a relay
// response (or, more realistically, an echoed title in some future field)
// carrying ANSI escapes that would otherwise change the user's terminal
// colour after our output ends.
// eslint-disable-next-line no-control-regex
const CTRL_RX = /[\x00-\x08\x0b-\x1f\x7f]/g;
function safe(s: string): string {
  return s.replace(CTRL_RX, "");
}

/** Generate the QR-code string for `text` using qrcode-terminal's `small`
 *  rendering (one terminal char per QR module, ~half the height of the
 *  default). Returns the multi-line string, ready to write to stdout. */
function qrToString(text: string): string {
  let out = "";
  qrcode.generate(text, { small: true }, (s) => {
    out = s;
  });
  return out;
}

/** Human-friendly countdown from now to `iso`. Returns "in 1h 0m" /
 *  "in 45m" / "in 30s" / "expired". Stable enough to test as a string. */
export function humanCountdown(iso: string, nowMs = Date.now()): string {
  const delta = new Date(iso).getTime() - nowMs;
  if (!Number.isFinite(delta) || delta <= 0) return "expired";
  const totalSec = Math.floor(delta / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  if (mins > 0) return `in ${mins}m`;
  return `in ${secs}s`;
}

/** Render the surface-created response for a human reader. Returns the
 *  full multi-line string; the caller writes it to stdout. */
export function formatSurfaceCreated(
  res: SurfaceCreatedView,
  opts: { color?: boolean } = {},
): string {
  const c = opts.color ?? false;
  const b = c ? ANSI.bold : "";
  const d = c ? ANSI.dim : "";
  const cy = c ? ANSI.cyan : "";
  const g = c ? ANSI.green : "";
  const r = c ? ANSI.reset : "";

  const title = safe(res.title);
  const surfaceId = safe(res.surface_id);
  const expiresIn = humanCountdown(res.expires_at);
  const expiresAt = safe(res.expires_at);
  const humanUrls = res.urls.humans.map(safe);
  const agentStream = safe(res.urls.agent_stream);

  const lines: string[] = [];
  // Header — "Surface created" vs. "Existing surface reused" if `created`
  // is explicitly false. Dedup hits from #262 carry created=false and the
  // human shouldn't think they made a fresh row.
  const headline =
    res.created === false
      ? `${b}${cy}Existing surface reused${r}`
      : `${b}${g}Pane surface created${r}`;
  lines.push(headline);
  lines.push("");
  lines.push(`  ${d}Title:${r}    ${title}`);
  lines.push(`  ${d}Surface:${r}  ${surfaceId}`);
  lines.push(`  ${d}Expires:${r}  ${expiresIn} ${d}(${expiresAt})${r}`);
  if (res.context_key) {
    lines.push(`  ${d}Key:${r}      ${safe(res.context_key)}`);
  }
  lines.push("");

  if (humanUrls.length === 0) {
    // Dedup-on-existing-surface path doesn't re-mint human URLs. Surface
    // the situation explicitly rather than rendering a blank section.
    lines.push(
      `${d}No human URLs minted on this response — fetch them with ` +
        `\`pane surface participants ${surfaceId}\`.${r}`,
    );
  } else {
    const label =
      humanUrls.length === 1 ? "Open this link" : "Open these links";
    lines.push(`${label} in a browser:`);
    lines.push("");
    for (const u of humanUrls) {
      lines.push(`  ${b}${u}${r}`);
    }
    lines.push("");
    // Show a QR for the first URL — scannable from a phone. The other
    // URLs (if any) are visible above; one QR keeps the output compact.
    lines.push(`Or scan this QR code with your phone:`);
    lines.push("");
    const qr = qrToString(humanUrls[0]!);
    // Indent each QR line by two spaces so it sits inside the same gutter
    // as the rest of the body.
    for (const ln of qr.split("\n")) {
      if (ln.length === 0) continue;
      lines.push(`  ${ln}`);
    }
    lines.push("");
  }

  lines.push(`${d}Agent stream:${r}  ${agentStream}`);
  return lines.join("\n") + "\n";
}
