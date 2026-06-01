// `pane skill` — fetch the relay's SKILL.md, or just its version.
//
// The relay serves its skill at GET /skills/pane/SKILL.md and its version
// at GET /skills/pane/SKILL.md/version (see
// packages/relay/src/http/routes/skill.ts). The skill is auto-updating:
// the relay's deployed image owns both the body and the version, so the
// agent always reads what the relay it's actually talking to wants it
// to read.
//
// Two verbs:
//   `pane skill show`      — print the full markdown to stdout (the
//                            install / refresh path; pipe to a file).
//   `pane skill version`   — print just the relay's skill version (the
//                            "is my local copy stale?" probe). The agent
//                            compares this to the `<!-- pane skill v… -->`
//                            comment in its local skill file and re-runs
//                            `pane skill show > <path>` when they differ.
//
// Both are unauthenticated — the skill route is public on the relay and
// an agent on a too-old CLI must be able to read the upgrade instructions
// even before it has registered (or before its key was minted).

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { resolveRelayUrl } from "../config.js";
import { fail } from "../output.js";

const NO_FLAGS: string[] = [];
const NO_BOOLS: string[] = [];
const VERSION_BOOLS = ["plain"];
import { VERSION } from "../version.js";

export const skillHelp = `pane skill — fetch the relay's SKILL.md (or its version)

Usage:
  pane skill show                     Print the full skill to stdout.
  pane skill version [--plain]        Print just the relay's skill version.

The skill is auto-updating: the relay's deployed image owns the version,
so this is always the skill that matches the relay you are talking to.

Unauthenticated — no API key needed. An agent can call either form
before 'pane agent register' to bootstrap or refresh its local skill copy.

Verbs:
  show                Fetch GET /skills/pane/SKILL.md and write the raw
                      markdown to stdout. Pipe to your local skill path:
                          pane skill show > ~/.claude/skills/pane/SKILL.md
  version             Fetch GET /skills/pane/SKILL.md/version and print
                      the relay's skill version. Default output is the
                      JSON envelope; --plain prints just the version
                      string so an agent can compare it inline in shell.

Options:
  --plain             (with 'version' only) print the bare version
                      string on stdout, no JSON envelope. Useful inside
                      a shell pipeline: \`if [ "$(pane skill version
                      --plain)" != "$LOCAL" ]; then ...\`.
  --url <url>         Relay base URL (overrides PANE_URL).
  -h, --help          Show this help.

Output (stdout):
  (bare)              Raw markdown, as served by the relay.
  version             { "version": "1.0.0" } — or '1.0.0\\n' with --plain.

Errors (stderr): { "error": { "code", "message" } } and non-zero exit.`;

// Shared fetch with the consistent x-pane-cli-version header (the skill
// routes are exempt from the version-skew middleware, but sending it lets
// access logs see which CLI versions are reading the skill).
async function fetchOrFail(url: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: { "x-pane-cli-version": VERSION },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`could not reach ${url}: ${msg}`, "fetch_error");
  }
}

async function failOnNon2xx(res: Response, target: string): Promise<void> {
  if (res.ok) return;
  // 404 if the operator stripped the route, 5xx on a static-read failure.
  // Pane the body inline — it may carry a useful message.
  const body = await res.text().catch(() => "");
  fail(
    `relay returned ${res.status} for ${target}${
      body ? ": " + body.slice(0, 200) : ""
    }`,
    "relay_error",
  );
}

// `pane skill show` — print the full skill.
async function runSkillFetch(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, NO_BOOLS, "pane skill show");

  const url = resolveRelayUrl(args);
  const target = url + "/skills/pane/SKILL.md";
  const res = await fetchOrFail(target);
  await failOnNon2xx(res, target);
  const text = await res.text();
  process.stdout.write(text);
  // Ensure the markdown ends with a newline so a pipe-reader (cat | xargs |
  // claude) sees a clean line-terminated boundary even if the relay served
  // a file without a trailing newline.
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

// `pane skill version [--plain]` — print just the version.
async function runSkillVersion(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, VERSION_BOOLS, "pane skill version");

  const url = resolveRelayUrl(args);
  const target = url + "/skills/pane/SKILL.md/version";
  const res = await fetchOrFail(target);
  await failOnNon2xx(res, target);

  // The relay returns { version: "x.y.z" }. We tolerate a missing/
  // malformed body so a misbehaving relay can't crash this probe — fall
  // through to "0.0.0" the same way the relay does when its own SKILL.md
  // lacks a version comment.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const version =
    body !== null &&
    typeof body === "object" &&
    typeof (body as { version?: unknown }).version === "string"
      ? (body as { version: string }).version
      : "0.0.0";

  if (args.bools.has("plain")) {
    process.stdout.write(version + "\n");
  } else {
    process.stdout.write(JSON.stringify({ version }) + "\n");
  }
}

export async function runSkill(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "show":
      await runSkillFetch(args);
      break;
    case "version":
      await runSkillVersion(args);
      break;
    case undefined:
      fail(
        "missing verb — usage: pane skill <show|version> (run 'pane skill --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown skill verb '${sub}' — expected show|version (run 'pane skill --help')`,
        "invalid_args",
      );
  }
}
