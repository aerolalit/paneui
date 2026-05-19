// `pane config` — show the resolved relay config without a network call.

import type { ParsedArgs } from "../argv.js";
import { describeConfig } from "../config.js";
import { printJson } from "../output.js";

export const configHelp = `pane config — show the resolved relay config

Usage:
  pane config [options]

Prints the relay URL and API-key info the CLI would use, and where each value
came from. Makes NO network call — purely inspects flags, env vars, and the
saved config file.

The API key is never printed in full: only a short masked prefix.

Options:
  --url <url>         Relay base URL (overrides PANE_URL) — affects the report.
  --api-key <key>     Agent API key (overrides PANE_API_KEY) — affects the
                      report.
  -h, --help          Show this help.

Output (stdout, JSON):
  {
    url,            relay base URL, or null if unset
    url_source,     "flag" | "env" | "store" | "none"
    key_prefix,     first ~10 chars of the API key + "…", or null
    key_source,     "flag" | "env" | "store" | "none"
    config_path     absolute path to the CLI config file
  }`;

export async function runConfig(args: ParsedArgs): Promise<void> {
  printJson(describeConfig(args));
}
