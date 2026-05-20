// `pane skill` — print the relay's SKILL.md to stdout.
//
// The relay serves its skill at GET /skills/pane/SKILL.md (see
// packages/relay/src/http/routes/skill.ts). That makes the skill
// auto-updating — the agent always reads what the relay it's actually
// talking to wants it to read, version-matched to that relay's image.
//
// This command exists so an agent can dump that text into its prompt at
// startup without hand-rolling the URL convention or wiring in a fetch.
// It is intentionally unauthenticated: the skill route is public on the
// relay and an agent on a too-old CLI must be able to read the upgrade
// instructions even before it has registered (or before its key was
// minted).
//
// Output is the raw markdown on stdout, byte-for-byte from the relay.
// Errors go to stderr in the same JSON envelope as every other command.

import type { ParsedArgs } from "../argv.js";
import { resolveRelayUrl } from "../config.js";
import { fail } from "../output.js";
import { VERSION } from "../version.js";

export const skillHelp = `pane skill — print the relay's SKILL.md to stdout

Usage:
  pane skill [options]

Fetches GET /skills/pane/SKILL.md from the configured relay and writes
the raw markdown to stdout. The skill is auto-updating: the relay's
deployed image owns the version, so this is always the skill that
matches the relay you are talking to.

Unauthenticated — no API key needed. An agent can call this before
'pane register' to obtain the relay's current setup / upgrade
instructions.

Options:
  --url <url>         Relay base URL (overrides PANE_URL).
  -h, --help          Show this help.

Output (stdout): raw markdown, as served by the relay.
Errors (stderr): { "error": { "code", "message" } } and non-zero exit.`;

export async function runSkill(args: ParsedArgs): Promise<void> {
  const url = resolveRelayUrl(args);
  const target = url + "/skills/pane/SKILL.md";

  let res: Response;
  try {
    res = await fetch(target, {
      headers: {
        // The relay's version-skew middleware is mounted on /v1/* only,
        // not /skills/*, so this header isn't strictly necessary here —
        // but we send it for consistency (and so log-based audits can
        // see which CLI versions are reading the skill).
        "x-pane-cli-version": VERSION,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`could not reach ${target}: ${msg}`, "fetch_error");
  }

  if (!res.ok) {
    // The relay's skill route can return 404 if the operator stripped it,
    // or 5xx if the static read failed. Either way, the body may carry a
    // useful message — surface it inline rather than swallow it.
    const body = await res.text().catch(() => "");
    fail(
      `relay returned ${res.status} for ${target}${
        body ? ": " + body.slice(0, 200) : ""
      }`,
      "relay_error",
    );
  }

  const text = await res.text();
  process.stdout.write(text);
  // Ensure the markdown ends with a newline so a pipe-reader (cat | xargs |
  // claude) sees a clean line-terminated boundary even if the relay served
  // a file without a trailing newline.
  if (!text.endsWith("\n")) process.stdout.write("\n");
}
