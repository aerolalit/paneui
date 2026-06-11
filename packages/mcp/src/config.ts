// Relay config resolution for the MCP server.
//
// Mirrors how `@paneui/cli` resolves config (see packages/cli/src/config.ts +
// store.ts) and shares the SAME on-disk store — ${XDG_CONFIG_HOME or
// ~/.config}/pane/config.json — so a key obtained via `pane agent register`
// is reused here, and a key obtained here (auto-register on first use) is
// reused by the CLI.
//
// Precedence (highest first):
//   url:    PANE_URL env  → active profile's url   → DEFAULT_RELAY_URL
//   apiKey: PANE_API_KEY  → PANE_TOKEN  → active profile's api_key
//
// PANE_TOKEN is accepted as an alias for PANE_API_KEY: MCP host config files
// (Claude Desktop / Cursor) commonly name secrets "*_TOKEN", and the task
// brief calls it PANE_TOKEN. PANE_API_KEY wins if both are set.
//
// The store is read/written WITHOUT a dependency on @paneui/cli (it doesn't
// export its store module). The on-disk shape is kept byte-compatible with
// the CLI's store.ts so the two stay interchangeable.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { PaneClient, registerAgent } from "@paneui/core";

/**
 * The hosted Pane relay — the URL fallback when nothing else is set. A
 * self-hoster overrides it with PANE_URL or a registered profile.
 */
export const DEFAULT_RELAY_URL = "https://relay.paneui.com";

/**
 * Profile name used when this server auto-registers a fresh agent. Matches the
 * CLI's DEFAULT_PROFILE_NAME so the two share the same default identity.
 */
export const DEFAULT_PROFILE_NAME = "default";

interface Profile {
  url?: string;
  apiKey?: string;
}

interface Store {
  currentProfile?: string;
  profiles: Record<string, Profile>;
}

/** Absolute path to the shared CLI/MCP config file (honours XDG_CONFIG_HOME). */
export function storePath(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "pane", "config.json");
}

/**
 * Read the persisted store. Returns an empty store if the file is missing,
 * unparseable, or malformed — mirrors the CLI's tolerant reader so a corrupt
 * file degrades to "no saved profile" instead of crashing.
 */
function readStore(): Store {
  let text: string;
  try {
    text = readFileSync(storePath(), "utf8");
  } catch {
    return { profiles: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { profiles: {} };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { profiles: {} };
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj["profiles"] || typeof obj["profiles"] !== "object") {
    return { profiles: {} };
  }
  const rawProfiles = obj["profiles"] as Record<string, unknown>;
  const profiles: Record<string, Profile> = {};
  for (const [name, raw] of Object.entries(rawProfiles)) {
    if (raw === null || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const profile: Profile = {};
    if (typeof p["url"] === "string") profile.url = p["url"];
    if (typeof p["api_key"] === "string") profile.apiKey = p["api_key"];
    profiles[name] = profile;
  }
  const currentProfile =
    typeof obj["current_profile"] === "string"
      ? (obj["current_profile"] as string)
      : undefined;
  return {
    currentProfile:
      currentProfile && profiles[currentProfile] !== undefined
        ? currentProfile
        : undefined,
    profiles,
  };
}

/** Serialise a Store to the CLI's on-disk JSON shape (snake_case fields). */
function serialize(store: Store): string {
  const profilesOut: Record<string, Record<string, string>> = {};
  for (const [name, p] of Object.entries(store.profiles)) {
    const o: Record<string, string> = {};
    if (p.url !== undefined) o["url"] = p.url;
    if (p.apiKey !== undefined) o["api_key"] = p.apiKey;
    profilesOut[name] = o;
  }
  const body: Record<string, unknown> = { profiles: profilesOut };
  if (store.currentProfile !== undefined) {
    body["current_profile"] = store.currentProfile;
  }
  return JSON.stringify(body, null, 2) + "\n";
}

/** Upsert one profile and persist (mode 0600). Used by auto-register. */
function upsertProfile(
  name: string,
  patch: Profile,
  setCurrent: boolean,
): void {
  const store = readStore();
  const merged: Profile = { ...(store.profiles[name] ?? {}), ...patch };
  store.profiles[name] = merged;
  if (setCurrent || store.currentProfile === undefined) {
    store.currentProfile = name;
  }
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialize(store), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Resolve the relay URL using the same precedence as the CLI. */
export function resolveUrl(): string {
  const store = readStore();
  const active = store.currentProfile
    ? store.profiles[store.currentProfile]
    : undefined;
  const url = process.env.PANE_URL ?? active?.url ?? DEFAULT_RELAY_URL;
  return url.replace(/\/$/, "");
}

/** Resolve the API key (env → PANE_TOKEN alias → active profile). */
function resolveApiKey(): string | undefined {
  const store = readStore();
  const active = store.currentProfile
    ? store.profiles[store.currentProfile]
    : undefined;
  const key =
    process.env.PANE_API_KEY ?? process.env.PANE_TOKEN ?? active?.apiKey;
  return key && key !== "" ? key : undefined;
}

/**
 * Resolve a ready-to-use PaneClient.
 *
 * First-run setup: if no API key is resolvable from the environment or the
 * shared store, the server auto-registers a fresh agent against the relay and
 * persists the key under the `default` profile in the shared store — so the
 * CLI and any later MCP launch reuse the same identity, and the human never
 * has to run `pane agent register` by hand.
 *
 * A self-hoster on a `secret`-mode relay (or anyone who prefers explicit
 * provisioning) sets PANE_API_KEY / PANE_TOKEN and the auto-register path is
 * never taken.
 *
 * `opts.agentName` labels the auto-registered agent on the relay.
 * `opts.registerSecret` is forwarded as the registration secret for
 * REGISTRATION_MODE=secret relays.
 */
export async function resolveClient(
  opts: {
    agentName?: string;
    registerSecret?: string;
  } = {},
): Promise<PaneClient> {
  const url = resolveUrl();
  let apiKey = resolveApiKey();

  if (apiKey === undefined) {
    // No key anywhere — provision one and persist it under `default`.
    const result = await registerAgent({
      url,
      name: opts.agentName ?? "pane-mcp",
      ...(opts.registerSecret !== undefined && opts.registerSecret !== ""
        ? { secret: opts.registerSecret }
        : {}),
    });
    upsertProfile(DEFAULT_PROFILE_NAME, { url, apiKey: result.api_key }, true);
    apiKey = result.api_key;
  }

  return new PaneClient({ url, apiKey });
}
