// Persisted CLI config: ${XDG_CONFIG_HOME or ~/.config}/pane/config.json.
//
// Holds one or more named profiles. Each profile is one agent identity on
// one relay — (url, api_key). Switching profiles is the multi-environment
// story: dev / staging / prod, or personal / work agents on the same relay,
// without re-running `pane agent register` between them.
//
// File layout (current):
//
//   {
//     "current_profile": "prod",
//     "profiles": {
//       "prod": { "url": "https://…", "api_key": "pane_…" },
//       "dev":  { "url": "http://localhost:3000", "api_key": "pane_…" }
//     }
//   }
//
// Backward compatibility: the pre-profile layout was `{ url, apiKey }`.
// `readStore` accepts both shapes; on the next write we persist the new
// shape, migrating the flat one into a `default` profile. No user action.
//
// Tiny and synchronous; no deps. Holds secrets — files written mode 0600.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Profile {
  url?: string;
  apiKey?: string;
}

export interface Store {
  /** Active profile name. May be undefined when the store is empty. */
  currentProfile?: string;
  /** Named profiles. Keyed by profile name; values hold (url, apiKey). */
  profiles: Record<string, Profile>;
}

/** Name of the profile created when migrating a pre-profile config file. */
export const LEGACY_DEFAULT_PROFILE = "default";

/** Profile-name validation (a-z, A-Z, 0-9, _ and -, 1..32 chars). */
const PROFILE_NAME_RX = /^[A-Za-z0-9_-]{1,32}$/;
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RX.test(name);
}

/** Absolute path to the config file (honours XDG_CONFIG_HOME). */
export function storePath(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "pane", "config.json");
}

/**
 * Read the persisted config. Returns an empty store if the file is missing
 * or unparseable. Accepts both the current `{ current_profile, profiles }`
 * shape and the legacy flat `{ url, apiKey }` — the latter is read as a
 * single `default` profile, but the file itself is left alone until the
 * next `writeStoreFull` call rewrites it in the new shape.
 */
export function readStore(): Store {
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

  // Current shape: { current_profile, profiles: { [name]: { url, api_key } } }
  if (obj["profiles"] && typeof obj["profiles"] === "object") {
    const rawProfiles = obj["profiles"] as Record<string, unknown>;
    const profiles: Record<string, Profile> = {};
    for (const [name, raw] of Object.entries(rawProfiles)) {
      if (raw === null || typeof raw !== "object") continue;
      const p = raw as Record<string, unknown>;
      const profile: Profile = {};
      if (typeof p["url"] === "string") profile.url = p["url"];
      // Accept either `api_key` (canonical on-disk) or `apiKey` (legacy
      // top-level field name) inside a profile — operators hand-editing
      // the file keep working both ways.
      if (typeof p["api_key"] === "string") profile.apiKey = p["api_key"];
      else if (typeof p["apiKey"] === "string") profile.apiKey = p["apiKey"];
      profiles[name] = profile;
    }
    const currentProfile =
      typeof obj["current_profile"] === "string"
        ? (obj["current_profile"] as string)
        : undefined;
    // If the named current profile was deleted out-of-band, drop it back
    // to undefined so the resolver can fall through to env / default URL.
    return {
      currentProfile:
        currentProfile && profiles[currentProfile] !== undefined
          ? currentProfile
          : undefined,
      profiles,
    };
  }

  // Legacy flat shape: { url, apiKey } → migrate to a single `default` profile.
  if (typeof obj["url"] === "string" || typeof obj["apiKey"] === "string") {
    const legacy: Profile = {};
    if (typeof obj["url"] === "string") legacy.url = obj["url"];
    if (typeof obj["apiKey"] === "string") legacy.apiKey = obj["apiKey"];
    return {
      currentProfile: LEGACY_DEFAULT_PROFILE,
      profiles: { [LEGACY_DEFAULT_PROFILE]: legacy },
    };
  }

  return { profiles: {} };
}

/** Serialise a Store to the on-disk JSON shape (snake_case fields). */
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

/**
 * Atomically write the whole Store to disk. The file is created with mode
 * 0600 and the parent directory is created as needed.
 */
export function writeStoreFull(store: Store): string {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialize(store), { mode: 0o600 });
  // Ensure mode even when the file pre-existed with looser permissions.
  chmodSync(path, 0o600);
  return path;
}

/**
 * Upsert a single profile and write back. If `setCurrent` is true, the
 * profile becomes the active one. If the store had no current profile yet
 * (empty store, or migrating from legacy), the newly-written profile
 * becomes current regardless — there's no other choice that makes sense.
 */
export function upsertProfile(
  name: string,
  patch: Profile,
  setCurrent = false,
): string {
  if (!isValidProfileName(name)) {
    throw new Error(
      `invalid profile name '${name}' — must match ${PROFILE_NAME_RX} (letters, digits, underscore, dash; 1..32 chars)`,
    );
  }
  const store = readStore();
  const merged: Profile = { ...(store.profiles[name] ?? {}), ...patch };
  store.profiles[name] = merged;
  if (setCurrent || store.currentProfile === undefined) {
    store.currentProfile = name;
  }
  return writeStoreFull(store);
}

/**
 * Set the active profile by name. Throws if `name` is not in the store.
 * Use `upsertProfile` if you also want to create it.
 */
export function setCurrentProfile(name: string): string {
  const store = readStore();
  if (store.profiles[name] === undefined) {
    throw new Error(
      `profile '${name}' does not exist — run 'pane config list' to see available profiles`,
    );
  }
  store.currentProfile = name;
  return writeStoreFull(store);
}

/**
 * Remove a profile. If it was current, drop `current_profile` (the resolver
 * falls through to env / default URL). If the resulting store is empty,
 * delete the file entirely so a `readStore` looks identical to "fresh".
 * Returns `{ path, was_current }`. Throws if the profile doesn't exist.
 */
export function removeProfile(name: string): {
  path: string;
  was_current: boolean;
} {
  const store = readStore();
  if (store.profiles[name] === undefined) {
    throw new Error(`profile '${name}' does not exist`);
  }
  const wasCurrent = store.currentProfile === name;
  delete store.profiles[name];
  if (wasCurrent) {
    store.currentProfile = undefined;
  }
  if (Object.keys(store.profiles).length === 0) {
    // Empty store → delete the file so a subsequent register starts fresh.
    return { path: clearStore(), was_current: wasCurrent };
  }
  return { path: writeStoreFull(store), was_current: wasCurrent };
}

/**
 * Delete the persisted config file entirely. Idempotent — no error if the
 * file never existed. Returns the path it targeted. Used by
 * `pane agent logout --all` and `removeProfile` when it drains the last
 * profile.
 */
export function clearStore(): string {
  const path = storePath();
  rmSync(path, { force: true });
  return path;
}

/**
 * Resolve which profile to load from the store, given the optional selector
 * (`--profile` flag or `PANE_PROFILE` env). Returns `null` if no profile
 * matches — i.e. the caller should fall through to env / default-URL
 * resolution. Throws if `selector` was explicit (truthy) and not found, so
 * a typo in `--profile dev` doesn't silently fall back to the wrong relay.
 */
export function resolveProfile(
  store: Store,
  selector: string | undefined,
): { name: string; profile: Profile } | null {
  if (selector !== undefined && selector !== "") {
    const p = store.profiles[selector];
    if (p === undefined) {
      const known = Object.keys(store.profiles).sort().join(", ") || "(none)";
      throw new Error(
        `profile '${selector}' does not exist (known: ${known}) — run 'pane config list'`,
      );
    }
    return { name: selector, profile: p };
  }
  if (store.currentProfile !== undefined) {
    const p = store.profiles[store.currentProfile];
    if (p !== undefined) return { name: store.currentProfile, profile: p };
  }
  return null;
}
