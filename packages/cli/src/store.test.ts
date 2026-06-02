// Unit tests for the persisted CLI config store and resolveConfig's store
// fallback. Each test points XDG_CONFIG_HOME at a fresh temp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStore,
  upsertProfile,
  setCurrentProfile,
  removeProfile,
  storePath,
  clearStore,
  resolveProfile,
  isValidProfileName,
} from "./store.js";
import { resolveConfig, DEFAULT_RELAY_URL } from "./config.js";
import type { ParsedArgs } from "./argv.js";

let dir: string;
let savedXdg: string | undefined;
let savedUrl: string | undefined;
let savedKey: string | undefined;
let savedProfile: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-store-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedUrl = process.env.PANE_URL;
  savedKey = process.env.PANE_API_KEY;
  savedProfile = process.env.PANE_PROFILE;
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.PANE_URL;
  delete process.env.PANE_API_KEY;
  delete process.env.PANE_PROFILE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedUrl === undefined) delete process.env.PANE_URL;
  else process.env.PANE_URL = savedUrl;
  if (savedKey === undefined) delete process.env.PANE_API_KEY;
  else process.env.PANE_API_KEY = savedKey;
  if (savedProfile === undefined) delete process.env.PANE_PROFILE;
  else process.env.PANE_PROFILE = savedProfile;
});

function emptyArgs(flags: Record<string, string> = {}): ParsedArgs {
  return {
    positionals: [],
    flags: new Map(Object.entries(flags)),
    bools: new Set(),
  };
}

describe("store", () => {
  it("storePath honours XDG_CONFIG_HOME", () => {
    expect(storePath()).toBe(join(dir, "pane", "config.json"));
  });

  it("readStore returns an empty store when the file is missing", () => {
    expect(readStore()).toEqual({ profiles: {} });
  });

  it("readStore returns an empty store on unparseable content", () => {
    mkdirSync(join(dir, "pane"), { recursive: true });
    writeFileSync(storePath(), "not json {{{");
    expect(readStore()).toEqual({ profiles: {} });
  });

  it("upsertProfile round-trips url + apiKey and makes it current on first add", () => {
    const path = upsertProfile("prod", {
      url: "https://relay.test",
      apiKey: "pk_abc",
    });
    expect(path).toBe(storePath());
    expect(readStore()).toEqual({
      currentProfile: "prod",
      profiles: { prod: { url: "https://relay.test", apiKey: "pk_abc" } },
    });
  });

  it("upsertProfile leaves current_profile alone for non-first profiles", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    upsertProfile("dev", { url: "https://b", apiKey: "pk_b" });
    const s = readStore();
    expect(s.currentProfile).toBe("prod"); // first one stays current
    expect(Object.keys(s.profiles).sort()).toEqual(["dev", "prod"]);
  });

  it("upsertProfile(setCurrent=true) flips the active profile", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    upsertProfile("dev", { url: "https://b", apiKey: "pk_b" }, true);
    expect(readStore().currentProfile).toBe("dev");
  });

  it("upsertProfile merges into an existing profile rather than replacing it", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    upsertProfile("prod", { apiKey: "pk_a_v2" });
    expect(readStore().profiles["prod"]).toEqual({
      url: "https://a",
      apiKey: "pk_a_v2",
    });
  });

  it("writes mode 0600", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "secret" });
    const mode = statSync(storePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("persists in snake_case on disk (api_key, current_profile)", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    const raw = readFileSync(storePath(), "utf8");
    expect(raw).toContain('"api_key"');
    expect(raw).toContain('"current_profile"');
    expect(raw).not.toContain('"apiKey"');
  });

  it("setCurrentProfile flips the active profile", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    upsertProfile("dev", { url: "https://b", apiKey: "pk_b" });
    setCurrentProfile("dev");
    expect(readStore().currentProfile).toBe("dev");
  });

  it("setCurrentProfile throws on an unknown profile name", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    expect(() => setCurrentProfile("nope")).toThrow(/does not exist/);
  });

  it("removeProfile drops the entry and clears current when it was current", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    upsertProfile("dev", { url: "https://b", apiKey: "pk_b" });
    const r = removeProfile("prod");
    expect(r.was_current).toBe(true);
    const after = readStore();
    expect(after.profiles).toEqual({
      dev: { url: "https://b", apiKey: "pk_b" },
    });
    expect(after.currentProfile).toBeUndefined();
  });

  it("removeProfile deletes the file once the last profile is gone", () => {
    upsertProfile("only", { url: "https://a", apiKey: "pk" });
    removeProfile("only");
    expect(existsSync(storePath())).toBe(false);
  });

  it("removeProfile throws on an unknown profile name", () => {
    expect(() => removeProfile("nope")).toThrow(/does not exist/);
  });

  it("clearStore deletes the file and returns its path", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk" });
    expect(existsSync(storePath())).toBe(true);
    const path = clearStore();
    expect(path).toBe(storePath());
    expect(existsSync(storePath())).toBe(false);
    expect(readStore()).toEqual({ profiles: {} });
  });

  it("clearStore is idempotent when no file exists", () => {
    expect(existsSync(storePath())).toBe(false);
    expect(() => clearStore()).not.toThrow();
    expect(clearStore()).toBe(storePath());
  });

  it("isValidProfileName accepts safe names and rejects junk", () => {
    expect(isValidProfileName("dev")).toBe(true);
    expect(isValidProfileName("work_2024-prod")).toBe(true);
    expect(isValidProfileName("default")).toBe(true);
    expect(isValidProfileName("")).toBe(false);
    expect(isValidProfileName("has space")).toBe(false);
    expect(isValidProfileName("dot.in.name")).toBe(false);
    expect(isValidProfileName("a".repeat(33))).toBe(false);
  });
});

describe("readStore — rejects malformed shapes", () => {
  it("returns an empty store for a flat { url, apiKey } file (no migration)", () => {
    mkdirSync(join(dir, "pane"), { recursive: true });
    writeFileSync(
      storePath(),
      JSON.stringify({ url: "https://old.test", apiKey: "pk_old" }),
    );
    // No back-compat. Files without a `profiles` object look like a fresh
    // install — re-run `pane agent register` (or `pane config add`) to
    // populate.
    expect(readStore()).toEqual({ profiles: {} });
  });

  it("ignores per-profile entries that aren't objects", () => {
    mkdirSync(join(dir, "pane"), { recursive: true });
    writeFileSync(
      storePath(),
      JSON.stringify({
        current_profile: "prod",
        profiles: { prod: "not-an-object", dev: { url: "https://x" } },
      }),
    );
    const s = readStore();
    expect(s.profiles["prod"]).toBeUndefined();
    expect(s.profiles["dev"]).toEqual({ url: "https://x" });
    // currentProfile pointed at a now-missing entry → undefined.
    expect(s.currentProfile).toBeUndefined();
  });

  it("ignores camelCase apiKey inside a profile (only api_key is read)", () => {
    mkdirSync(join(dir, "pane"), { recursive: true });
    writeFileSync(
      storePath(),
      JSON.stringify({
        current_profile: "p",
        profiles: { p: { url: "https://x", apiKey: "leaked" } },
      }),
    );
    const s = readStore();
    expect(s.profiles["p"]).toEqual({ url: "https://x" });
  });
});

describe("resolveProfile", () => {
  it("returns the named profile when selector matches", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    upsertProfile("dev", { url: "https://b", apiKey: "pk_b" });
    const s = readStore();
    expect(resolveProfile(s, "dev")?.name).toBe("dev");
  });

  it("throws on an unknown selector (no silent fallback)", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    const s = readStore();
    expect(() => resolveProfile(s, "nope")).toThrow(/does not exist/);
  });

  it("falls back to current_profile when no selector is given", () => {
    upsertProfile("prod", { url: "https://a", apiKey: "pk_a" });
    upsertProfile("dev", { url: "https://b", apiKey: "pk_b" });
    setCurrentProfile("dev");
    const s = readStore();
    expect(resolveProfile(s, undefined)?.name).toBe("dev");
  });

  it("returns null when neither selector nor current_profile yields a hit", () => {
    expect(resolveProfile({ profiles: {} }, undefined)).toBeNull();
  });
});

describe("resolveConfig store fallback", () => {
  it("falls back to the active profile when no flag or env is set", () => {
    upsertProfile("prod", {
      url: "https://stored.test",
      apiKey: "pk_stored",
    });
    expect(resolveConfig(emptyArgs())).toEqual({
      url: "https://stored.test",
      apiKey: "pk_stored",
    });
  });

  it("env beats the store", () => {
    upsertProfile("prod", {
      url: "https://stored.test",
      apiKey: "pk_stored",
    });
    process.env.PANE_URL = "https://env.test";
    process.env.PANE_API_KEY = "pk_env";
    expect(resolveConfig(emptyArgs())).toEqual({
      url: "https://env.test",
      apiKey: "pk_env",
    });
  });

  it("flags beat env and the store", () => {
    upsertProfile("prod", {
      url: "https://stored.test",
      apiKey: "pk_stored",
    });
    process.env.PANE_URL = "https://env.test";
    process.env.PANE_API_KEY = "pk_env";
    expect(
      resolveConfig(
        emptyArgs({ url: "https://flag.test", "api-key": "pk_flag" }),
      ),
    ).toEqual({ url: "https://flag.test", apiKey: "pk_flag" });
  });

  it("--profile selects a non-current profile", () => {
    upsertProfile("prod", { url: "https://prod.test", apiKey: "pk_prod" });
    upsertProfile("dev", { url: "https://dev.test", apiKey: "pk_dev" });
    // prod is current (first one written).
    expect(resolveConfig(emptyArgs())).toEqual({
      url: "https://prod.test",
      apiKey: "pk_prod",
    });
    expect(resolveConfig(emptyArgs({ profile: "dev" }))).toEqual({
      url: "https://dev.test",
      apiKey: "pk_dev",
    });
  });

  it("PANE_PROFILE env selects a profile when no flag is given", () => {
    upsertProfile("prod", { url: "https://prod.test", apiKey: "pk_prod" });
    upsertProfile("dev", { url: "https://dev.test", apiKey: "pk_dev" });
    process.env.PANE_PROFILE = "dev";
    expect(resolveConfig(emptyArgs())).toEqual({
      url: "https://dev.test",
      apiKey: "pk_dev",
    });
  });

  it("--profile beats PANE_PROFILE", () => {
    upsertProfile("prod", { url: "https://prod.test", apiKey: "pk_prod" });
    upsertProfile("dev", { url: "https://dev.test", apiKey: "pk_dev" });
    process.env.PANE_PROFILE = "dev";
    expect(resolveConfig(emptyArgs({ profile: "prod" }))).toEqual({
      url: "https://prod.test",
      apiKey: "pk_prod",
    });
  });

  it("falls back to DEFAULT_RELAY_URL when neither flag/env/profile sets a URL", () => {
    // Profile with only an apiKey — no URL anywhere. The hosted relay is the
    // last-resort fallback so a fresh user needs only a key.
    upsertProfile("prod", { apiKey: "pk_stored" });
    expect(resolveConfig(emptyArgs())).toEqual({
      url: DEFAULT_RELAY_URL,
      apiKey: "pk_stored",
    });
  });
});
