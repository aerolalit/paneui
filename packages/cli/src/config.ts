// Relay connection config: PANE_URL / PANE_API_KEY from the environment,
// overridable per-invocation with --url / --api-key.

import { PaneClient } from "@pane/core";
import type { ParsedArgs } from "./argv.js";
import { fail } from "./output.js";
import { readStore } from "./store.js";

export interface ResolvedConfig {
  url: string;
  apiKey: string;
}

/**
 * Resolve relay URL + API key. Precedence (highest first):
 *   url:    --url flag  → PANE_URL env      → store.url
 *   apiKey: --api-key   → PANE_API_KEY env  → store.apiKey
 * The store is written by `pane register`, so later commands need no env vars.
 */
export function resolveConfig(args: ParsedArgs): ResolvedConfig {
  const store = readStore();
  const url = args.flags.get("url") ?? process.env.PANE_URL ?? store.url ?? "";
  const apiKey =
    args.flags.get("api-key") ?? process.env.PANE_API_KEY ?? store.apiKey ?? "";

  if (!url) {
    fail(
      "missing relay URL: set PANE_URL, pass --url <relay-base-url>, or run 'pane register'",
      "config_error",
    );
  }
  if (!apiKey) {
    fail(
      "missing API key: set PANE_API_KEY, pass --api-key <key>, or run 'pane register'",
      "config_error",
    );
  }
  return { url: url.replace(/\/$/, ""), apiKey };
}

/** Build a PaneClient from resolved config. */
export function makeClient(args: ParsedArgs): PaneClient {
  const cfg = resolveConfig(args);
  return new PaneClient({ url: cfg.url, apiKey: cfg.apiKey });
}
