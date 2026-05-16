// Unit tests for the persisted CLI config store and resolveConfig's store
// fallback. Each test points XDG_CONFIG_HOME at a fresh temp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStore, writeStore, storePath } from "./store.js";
import { resolveConfig } from "./config.js";
import type { ParsedArgs } from "./argv.js";

let dir: string;
let savedXdg: string | undefined;
let savedUrl: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-store-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedUrl = process.env.PANE_URL;
  savedKey = process.env.PANE_API_KEY;
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.PANE_URL;
  delete process.env.PANE_API_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedUrl === undefined) delete process.env.PANE_URL;
  else process.env.PANE_URL = savedUrl;
  if (savedKey === undefined) delete process.env.PANE_API_KEY;
  else process.env.PANE_API_KEY = savedKey;
});

function emptyArgs(flags: Record<string, string> = {}): ParsedArgs {
  return { positionals: [], flags: new Map(Object.entries(flags)), bools: new Set() };
}

describe("store", () => {
  it("storePath honours XDG_CONFIG_HOME", () => {
    expect(storePath()).toBe(join(dir, "pane", "config.json"));
  });

  it("readStore returns {} when the file is missing", () => {
    expect(readStore()).toEqual({});
  });

  it("readStore returns {} on unparseable content", () => {
    mkdirSync(join(dir, "pane"), { recursive: true });
    writeFileSync(storePath(), "not json {{{");
    expect(readStore()).toEqual({});
  });

  it("writeStore round-trips url + apiKey", () => {
    const path = writeStore({ url: "https://relay.test", apiKey: "pk_abc" });
    expect(path).toBe(storePath());
    expect(readStore()).toEqual({ url: "https://relay.test", apiKey: "pk_abc" });
  });

  it("writeStore merges into the existing file", () => {
    writeStore({ url: "https://relay.test" });
    writeStore({ apiKey: "pk_abc" });
    expect(readStore()).toEqual({ url: "https://relay.test", apiKey: "pk_abc" });
  });

  it("writeStore creates the dir and writes mode 0600", () => {
    writeStore({ apiKey: "secret" });
    const mode = statSync(storePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("resolveConfig store fallback", () => {
  it("falls back to the store when no flag or env is set", () => {
    writeStore({ url: "https://stored.test", apiKey: "pk_stored" });
    expect(resolveConfig(emptyArgs())).toEqual({
      url: "https://stored.test",
      apiKey: "pk_stored",
    });
  });

  it("env beats the store", () => {
    writeStore({ url: "https://stored.test", apiKey: "pk_stored" });
    process.env.PANE_URL = "https://env.test";
    process.env.PANE_API_KEY = "pk_env";
    expect(resolveConfig(emptyArgs())).toEqual({
      url: "https://env.test",
      apiKey: "pk_env",
    });
  });

  it("flags beat env and the store", () => {
    writeStore({ url: "https://stored.test", apiKey: "pk_stored" });
    process.env.PANE_URL = "https://env.test";
    process.env.PANE_API_KEY = "pk_env";
    expect(
      resolveConfig(emptyArgs({ url: "https://flag.test", "api-key": "pk_flag" })),
    ).toEqual({ url: "https://flag.test", apiKey: "pk_flag" });
  });
});
