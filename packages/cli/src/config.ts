// Relay connection config: PANE_URL / PANE_API_KEY from the environment,
// overridable per-invocation with --url / --api-key.

import { PaneClient } from "@pane/core";
import type { ParsedArgs } from "./argv.js";
import { fail } from "./output.js";

export interface ResolvedConfig {
  url: string;
  apiKey: string;
}

/** Resolve relay URL + API key from flags, falling back to env vars. */
export function resolveConfig(args: ParsedArgs): ResolvedConfig {
  const url = args.flags.get("url") ?? process.env.PANE_URL ?? "";
  const apiKey = args.flags.get("api-key") ?? process.env.PANE_API_KEY ?? "";

  if (!url) {
    fail(
      "missing relay URL: set PANE_URL or pass --url <relay-base-url>",
      "config_error",
    );
  }
  if (!apiKey) {
    fail(
      "missing API key: set PANE_API_KEY or pass --api-key <key>",
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
