// Tests for `pane config` — provenance reporting and key masking.
//
// describeConfig makes no network call, so no client mock is needed. Each test
// points XDG_CONFIG_HOME at a fresh temp dir to isolate the store.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfig } from "./config.js";
import { writeStore, storePath } from "../store.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes"]);

function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let dir: string;
let savedXdg: string | undefined;
let savedUrl: string | undefined;
let savedKey: string | undefined;
let stdout: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-config-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedUrl = process.env.PANE_URL;
  savedKey = process.env.PANE_API_KEY;
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.PANE_URL;
  delete process.env.PANE_API_KEY;
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
  if (savedUrl === undefined) delete process.env.PANE_URL;
  else process.env.PANE_URL = savedUrl;
  if (savedKey === undefined) delete process.env.PANE_API_KEY;
  else process.env.PANE_API_KEY = savedKey;
  vi.restoreAllMocks();
});

describe("runConfig", () => {
  it("reports source 'none' when nothing is configured", async () => {
    await runConfig(argv(["show"]));
    const out = JSON.parse(stdout);
    expect(out).toEqual({
      url: null,
      url_source: "none",
      key_prefix: null,
      key_source: "none",
      config_path: storePath(),
    });
  });

  it("reports source 'store' when only the saved config is set", async () => {
    writeStore({
      url: "https://stored.test",
      apiKey: "pk_storedsecret_abcdef",
    });
    await runConfig(argv(["show"]));
    const out = JSON.parse(stdout);
    expect(out.url).toBe("https://stored.test");
    expect(out.url_source).toBe("store");
    expect(out.key_source).toBe("store");
  });

  it("reports source 'env' when env vars are set", async () => {
    process.env.PANE_URL = "https://env.test";
    process.env.PANE_API_KEY = "pk_envsecret_value";
    await runConfig(argv(["show"]));
    const out = JSON.parse(stdout);
    expect(out.url_source).toBe("env");
    expect(out.key_source).toBe("env");
  });

  it("reports source 'flag' and flags beat env beat store", async () => {
    writeStore({ url: "https://stored.test", apiKey: "pk_stored" });
    process.env.PANE_URL = "https://env.test";
    process.env.PANE_API_KEY = "pk_env";
    await runConfig(
      argv([
        "show",
        "--url",
        "https://flag.test",
        "--api-key",
        "pk_flagsecret",
      ]),
    );
    const out = JSON.parse(stdout);
    expect(out.url).toBe("https://flag.test");
    expect(out.url_source).toBe("flag");
    expect(out.key_source).toBe("flag");
  });

  it("never prints the full API key — only a masked prefix", async () => {
    const fullKey = "pk_thisisaverylongsecretkey_DO_NOT_LEAK_1234567890";
    writeStore({ url: "https://stored.test", apiKey: fullKey });
    await runConfig(argv(["show"]));
    expect(stdout).not.toContain(fullKey);
    expect(stdout).not.toContain("DO_NOT_LEAK");
    const out = JSON.parse(stdout);
    expect(out.key_prefix).toBe(fullKey.slice(0, 10) + "…");
    expect(fullKey.startsWith(out.key_prefix.replace("…", ""))).toBe(true);
  });
});
