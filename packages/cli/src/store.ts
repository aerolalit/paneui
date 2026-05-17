// Persisted CLI config: ${XDG_CONFIG_HOME or ~/.config}/pane/config.json.
//
// Holds the relay URL and the agent API key obtained via `pane register`, so
// later commands need no env vars. The file holds a secret — it is written
// 0600. Tiny and synchronous; no deps.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Store {
  url?: string;
  apiKey?: string;
}

/** Absolute path to the config file (honours XDG_CONFIG_HOME). */
export function storePath(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "pane", "config.json");
}

/** Read the persisted config. Returns {} if the file is missing or unparseable. */
export function readStore(): Store {
  let text: string;
  try {
    text = readFileSync(storePath(), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const out: Store = {};
    if (typeof parsed.url === "string") out.url = parsed.url;
    if (typeof parsed.apiKey === "string") out.apiKey = parsed.apiKey;
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the existing config and write it back as pretty JSON.
 * Creates the parent directory if needed; the file is written with mode 0600.
 */
export function writeStore(patch: Store): string {
  const path = storePath();
  const merged: Store = { ...readStore(), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  // Ensure mode even if the file pre-existed with looser permissions.
  chmodSync(path, 0o600);
  return path;
}
