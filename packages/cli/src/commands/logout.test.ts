// Tests for `pane agent logout` — clears the active profile by default,
// the whole store with --all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogout } from "./logout.js";
import { upsertProfile, readStore, storePath } from "../store.js";

let dir: string;
let savedXdg: string | undefined;
let savedProfile: string | undefined;
let stdout: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-logout-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedProfile = process.env.PANE_PROFILE;
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.PANE_PROFILE;
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += s;
    return true;
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedProfile === undefined) delete process.env.PANE_PROFILE;
  else process.env.PANE_PROFILE = savedProfile;
  vi.restoreAllMocks();
});

describe("runLogout — default (clear active profile only)", () => {
  it("removes the current profile and keeps the others", async () => {
    upsertProfile("prod", { url: "https://prod.test", apiKey: "pk_prod" });
    upsertProfile("dev", { url: "https://dev.test", apiKey: "pk_dev" }, true);

    await runLogout({ positionals: [], flags: new Map(), bools: new Set() });

    const after = readStore();
    expect(Object.keys(after.profiles)).toEqual(["prod"]);
    // current is cleared (nothing auto-promotes).
    expect(after.currentProfile).toBeUndefined();
    expect(JSON.parse(stdout)).toMatchObject({
      cleared: true,
      profile: "dev",
    });
  });

  it("deletes the file when the last profile is logged out", async () => {
    upsertProfile("only", { url: "https://x", apiKey: "pk" });
    await runLogout({ positionals: [], flags: new Map(), bools: new Set() });
    expect(existsSync(storePath())).toBe(false);
  });

  it("is idempotent when there is nothing to clear", async () => {
    expect(existsSync(storePath())).toBe(false);
    await runLogout({ positionals: [], flags: new Map(), bools: new Set() });
    const body = JSON.parse(stdout);
    expect(body.cleared).toBe(true);
    expect(body.profile).toBeNull();
  });

  it("--profile <name> targets a specific profile", async () => {
    upsertProfile("prod", { url: "https://prod.test", apiKey: "pk_prod" });
    upsertProfile("dev", { url: "https://dev.test", apiKey: "pk_dev" });

    await runLogout({
      positionals: [],
      flags: new Map([["profile", "prod"]]),
      bools: new Set(),
    });

    const after = readStore();
    expect(Object.keys(after.profiles)).toEqual(["dev"]);
  });
});

describe("runLogout --all", () => {
  it("deletes every profile and removes the config file", async () => {
    upsertProfile("prod", { url: "https://prod.test", apiKey: "pk_prod" });
    upsertProfile("dev", { url: "https://dev.test", apiKey: "pk_dev" });

    await runLogout({
      positionals: [],
      flags: new Map(),
      bools: new Set(["all"]),
    });

    expect(existsSync(storePath())).toBe(false);
    const body = JSON.parse(stdout);
    expect(body.cleared).toBe(true);
    expect(body.profile).toBeNull();
  });
});
