// Tests for `pane config` — provenance reporting, key masking, and the
// list/use/add/rm verbs.
//
// describeConfig makes no network call, so no client mock is needed. Each
// test points XDG_CONFIG_HOME at a fresh temp dir to isolate the store.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfig } from "./config.js";
import { upsertProfile, readStore, storePath } from "../store.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes"]);

function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let dir: string;
let savedXdg: string | undefined;
let savedUrl: string | undefined;
let savedKey: string | undefined;
let savedProfile: string | undefined;
let stdout: string;
let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-config-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedUrl = process.env.PANE_URL;
  savedKey = process.env.PANE_API_KEY;
  savedProfile = process.env.PANE_PROFILE;
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.PANE_URL;
  delete process.env.PANE_API_KEY;
  delete process.env.PANE_PROFILE;
  stdout = "";
  stderr = "";
  exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += s;
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += s;
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
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
  vi.restoreAllMocks();
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runConfig(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("pane config show", () => {
  it("reports source 'none' when nothing is configured", async () => {
    await run(["show"]);
    const out = JSON.parse(stdout);
    expect(out.url).toBeNull();
    expect(out.url_source).toBe("none");
    expect(out.key_prefix).toBeNull();
    expect(out.key_source).toBe("none");
    expect(out.profile).toBeNull();
    expect(out.profile_source).toBe("none");
    expect(out.config_path).toBe(storePath());
  });

  it("reports source 'profile' when only the saved config is set", async () => {
    upsertProfile("default", {
      url: "https://stored.test",
      apiKey: "pk_storedsecret_abcdef",
    });
    await run(["show"]);
    const out = JSON.parse(stdout);
    expect(out.url).toBe("https://stored.test");
    expect(out.url_source).toBe("profile");
    expect(out.key_source).toBe("profile");
    expect(out.profile).toBe("default");
    expect(out.profile_source).toBe("none"); // resolved via current_profile
  });

  it("reports source 'env' when env vars are set", async () => {
    process.env.PANE_URL = "https://env.test";
    process.env.PANE_API_KEY = "pk_envsecret_value";
    await run(["show"]);
    const out = JSON.parse(stdout);
    expect(out.url_source).toBe("env");
    expect(out.key_source).toBe("env");
  });

  it("reports source 'flag' and flags beat env beat profile", async () => {
    upsertProfile("default", {
      url: "https://stored.test",
      apiKey: "pk_stored",
    });
    process.env.PANE_URL = "https://env.test";
    process.env.PANE_API_KEY = "pk_env";
    await run([
      "show",
      "--url",
      "https://flag.test",
      "--api-key",
      "pk_flagsecret",
    ]);
    const out = JSON.parse(stdout);
    expect(out.url).toBe("https://flag.test");
    expect(out.url_source).toBe("flag");
    expect(out.key_source).toBe("flag");
  });

  it("reports profile_source 'flag' / 'env' when set via --profile / PANE_PROFILE", async () => {
    upsertProfile("prod", { url: "https://prod", apiKey: "pk_prod" });
    upsertProfile("dev", { url: "https://dev", apiKey: "pk_dev" });

    await run(["show", "--profile", "dev"]);
    let out = JSON.parse(stdout);
    expect(out.profile).toBe("dev");
    expect(out.profile_source).toBe("flag");
    expect(out.url).toBe("https://dev");

    // Reset stdout, switch via env.
    stdout = "";
    process.env.PANE_PROFILE = "dev";
    await run(["show"]);
    out = JSON.parse(stdout);
    expect(out.profile).toBe("dev");
    expect(out.profile_source).toBe("env");
  });

  it("never prints the full API key — only a masked prefix", async () => {
    const fullKey = "pk_thisisaverylongsecretkey_DO_NOT_LEAK_1234567890";
    upsertProfile("default", { url: "https://stored.test", apiKey: fullKey });
    await run(["show"]);
    expect(stdout).not.toContain(fullKey);
    expect(stdout).not.toContain("DO_NOT_LEAK");
    const out = JSON.parse(stdout);
    expect(out.key_prefix).toBe(fullKey.slice(0, 10) + "…");
  });
});

describe("pane config list", () => {
  it("lists every profile with URL + masked prefix + current marker", async () => {
    upsertProfile("prod", {
      url: "https://prod.test",
      apiKey: "pane_prodprod1234",
    });
    upsertProfile("dev", {
      url: "https://dev.test",
      apiKey: "pane_devdevdev",
    });
    await run(["list"]);
    const out = JSON.parse(stdout);
    expect(out.current).toBe("prod");
    expect(out.profiles).toHaveLength(2);
    const prod = out.profiles.find((p: { name: string }) => p.name === "prod");
    expect(prod.url).toBe("https://prod.test");
    expect(prod.current).toBe(true);
    expect(prod.key_prefix).toBe("pane_prodpr…");
  });

  it("returns an empty list with current=null on a fresh install", async () => {
    await run(["list"]);
    const out = JSON.parse(stdout);
    expect(out.current).toBeNull();
    expect(out.profiles).toEqual([]);
  });
});

describe("pane config use", () => {
  it("flips the active profile", async () => {
    upsertProfile("prod", { url: "https://prod", apiKey: "pk_prod" });
    upsertProfile("dev", { url: "https://dev", apiKey: "pk_dev" });
    await run(["use", "dev"]);
    expect(readStore().currentProfile).toBe("dev");
    const out = JSON.parse(stdout);
    expect(out.profile).toBe("dev");
  });

  it("fails with config_error on an unknown profile", async () => {
    upsertProfile("prod", { url: "https://prod", apiKey: "pk_prod" });
    await run(["use", "missing"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("config_error");
  });

  it("fails with invalid_args when the profile name is missing", async () => {
    await run(["use"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
  });
});

describe("pane config add", () => {
  it("creates a new profile without switching current", async () => {
    upsertProfile("prod", { url: "https://prod", apiKey: "pk_prod" });
    await run(["add", "dev", "--url", "https://dev", "--api-key", "pk_dev"]);
    const after = readStore();
    expect(after.currentProfile).toBe("prod"); // unchanged
    expect(after.profiles["dev"]).toEqual({
      url: "https://dev",
      apiKey: "pk_dev",
    });
  });

  it("creates the very first profile AND sets it current", async () => {
    await run(["add", "only", "--url", "https://only", "--api-key", "pk_only"]);
    expect(readStore().currentProfile).toBe("only");
  });

  it("requires --url and --api-key", async () => {
    await run(["add", "dev"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--url");
  });

  it("rejects invalid profile names", async () => {
    await run(["add", "with space", "--url", "https://x", "--api-key", "pk"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
  });
});

describe("pane config rm", () => {
  it("removes a profile and reports was_current correctly", async () => {
    upsertProfile("prod", { url: "https://prod", apiKey: "pk_prod" });
    upsertProfile("dev", { url: "https://dev", apiKey: "pk_dev" });
    await run(["rm", "prod"]);
    const out = JSON.parse(stdout);
    expect(out.was_current).toBe(true);
    const after = readStore();
    expect(Object.keys(after.profiles)).toEqual(["dev"]);
    expect(after.currentProfile).toBeUndefined();
  });

  it("fails with config_error on an unknown profile", async () => {
    await run(["rm", "missing"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("config_error");
  });
});

describe("pane config — unknown verb / no verb", () => {
  it("fails on an unknown verb", async () => {
    await run(["bogus"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
  });

  it("fails with helpful text when no verb is given", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing verb");
  });
});
