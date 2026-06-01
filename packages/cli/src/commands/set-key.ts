// `pane agent set-key <key>` — write a fresh API key into the CLI config
// file. The companion to the human-side rotation flow on /my-agents: after
// the human regenerates a key in the browser, this command lands it on
// the agent's machine without making them hand-edit ~/.config/pane/config.json.
//
// No relay round-trip: we trust the human-supplied key. The relay will
// reject it on the next call if it's wrong (401 invalid_api_key) — better
// than guessing here and adding a network hop for what's a local config
// write.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { readStore, writeStore } from "../store.js";
import { printJson, fail } from "../output.js";

const KNOWN_FLAGS = ["url"];
const KNOWN_BOOLS: string[] = [];

export const setKeyHelp = `pane agent set-key <api-key> — save a new API key to the local config

Usage:
  pane agent set-key <api-key> [--url <url>]

After regenerating an agent's API key in the relay's My-agents UI, run
this on the agent's machine to land the new key in the CLI config file
(\${XDG_CONFIG_HOME:-~/.config}/pane/config.json, mode 0600). Every later
command then works with no PANE_API_KEY env var.

If you'd rather not touch the config file at all, set the new key as the
PANE_API_KEY env var on the agent process — both work.

Options:
  --url <url>     Also update the saved relay URL. Useful when pointing the
                  agent at a different relay alongside the key swap.
  -h, --help      Show this help.

Output (stdout, JSON):
  { saved_to, key_prefix }

The key is never echoed back. To verify, run \`pane key list\` afterwards.`;

function keyPrefixOf(key: string): string {
  // Match the relay's keyPrefix() display width for "pane_" + 6 hex chars
  // (11 total). Falls back to the first 8 chars for any unrecognised shape.
  if (key.startsWith("pane_") && key.length >= 11) return key.slice(0, 11);
  return key.slice(0, 8);
}

export async function runSetKey(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane agent set-key");

  const apiKey = args.positionals[0];
  if (!apiKey) {
    fail(
      "missing api-key — usage: pane agent set-key <api-key>",
      "invalid_args",
    );
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    fail("api-key must be a non-empty string", "invalid_args");
  }

  // Best-effort shape check. The relay generates `pane_<32 hex>`; we don't
  // reject other shapes outright (a future format change shouldn't strand
  // older CLIs), but we warn on something obviously wrong like leading
  // whitespace.
  const trimmed = apiKey.trim();
  if (trimmed !== apiKey) {
    fail(
      "api-key has surrounding whitespace — copy it without leading/trailing spaces",
      "invalid_args",
    );
  }

  const patch: { apiKey: string; url?: string } = { apiKey };
  const urlFlag = args.flags.get("url");
  if (urlFlag !== undefined) patch.url = urlFlag;

  const saved = writeStore(patch);
  // Re-read so we report the prefix from the persisted value, not the
  // argument — defensive against future write-side normalisation.
  const after = readStore();
  printJson({
    saved_to: saved,
    key_prefix: keyPrefixOf(after.apiKey ?? apiKey),
  });
}
