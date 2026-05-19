// Relay connection config: PANE_URL / PANE_API_KEY from the environment,
// overridable per-invocation with --url / --api-key.

import { PaneClient } from "@pane/core";
import type { ParsedArgs } from "./argv.js";
import { fail } from "./output.js";
import { readStore, storePath } from "./store.js";

export interface ResolvedConfig {
  url: string;
  apiKey: string;
}

/** Where a resolved config value came from, in precedence order. */
export type ConfigSource = "flag" | "env" | "store" | "none";

/** A non-failing description of the resolved relay config, for `pane config`. */
export interface ConfigDescription {
  url: string | null;
  url_source: ConfigSource;
  key_prefix: string | null;
  key_source: ConfigSource;
  config_path: string;
}

/**
 * Resolve url + apiKey and report the SOURCE of each, WITHOUT making a network
 * call and WITHOUT failing on a missing value (unlike `resolveConfig`). The
 * full API key is never returned — only a short, masked prefix.
 */
export function describeConfig(args: ParsedArgs): ConfigDescription {
  const store = readStore();

  let url: string | null = null;
  let urlSource: ConfigSource = "none";
  if (args.flags.get("url")) {
    url = args.flags.get("url")!;
    urlSource = "flag";
  } else if (process.env.PANE_URL) {
    url = process.env.PANE_URL;
    urlSource = "env";
  } else if (store.url) {
    url = store.url;
    urlSource = "store";
  }

  let apiKey: string | null = null;
  let keySource: ConfigSource = "none";
  if (args.flags.get("api-key")) {
    apiKey = args.flags.get("api-key")!;
    keySource = "flag";
  } else if (process.env.PANE_API_KEY) {
    apiKey = process.env.PANE_API_KEY;
    keySource = "env";
  } else if (store.apiKey) {
    apiKey = store.apiKey;
    keySource = "store";
  }

  return {
    url: url ? url.replace(/\/$/, "") : null,
    url_source: urlSource,
    key_prefix: apiKey ? apiKey.slice(0, 10) + "…" : null,
    key_source: keySource,
    config_path: storePath(),
  };
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
