import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSetKey } from "./set-key.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key"]);
function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let xdgDir: string;
let stdout: string;
let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  // Isolate the CLI's config file under a fresh tmpdir per test so we
  // don't trample the developer's real ~/.config/pane/config.json.
  xdgDir = mkdtempSync(join(tmpdir(), "pane-setkey-test-"));
  process.env.XDG_CONFIG_HOME = xdgDir;

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
  vi.restoreAllMocks();
  rmSync(xdgDir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runSetKey(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("pane agent set-key", () => {
  it("writes the supplied key under the active profile (mode 0600)", async () => {
    const key = "pane_" + "a".repeat(32);
    await run([key]);
    const out = JSON.parse(stdout);
    expect(out.saved_to).toContain(join(xdgDir, "pane", "config.json"));
    expect(out.key_prefix).toBe("pane_aaaaaa");
    expect(out.profile).toBe("default"); // fresh install → 'default'

    const written = JSON.parse(readFileSync(out.saved_to, "utf8")) as {
      current_profile: string;
      profiles: Record<string, { url?: string; api_key: string }>;
    };
    expect(written.current_profile).toBe("default");
    expect(written.profiles["default"]!.api_key).toBe(key);
  });

  it("preserves an existing relay URL on the profile when only the key is rotated", async () => {
    const { upsertProfile } = await import("../store.js");
    upsertProfile("default", { url: "https://relay.example.test" });

    const key = "pane_" + "b".repeat(32);
    await run([key]);
    const out = JSON.parse(stdout);
    const written = JSON.parse(readFileSync(out.saved_to, "utf8")) as {
      profiles: Record<string, { url: string; api_key: string }>;
    };
    expect(written.profiles["default"]!.url).toBe("https://relay.example.test");
    expect(written.profiles["default"]!.api_key).toBe(key);
  });

  it("optionally updates the relay URL alongside the key", async () => {
    const key = "pane_" + "c".repeat(32);
    await run([key, "--url", "https://different.example.test"]);
    const out = JSON.parse(stdout);
    const written = JSON.parse(readFileSync(out.saved_to, "utf8")) as {
      profiles: Record<string, { url: string; api_key: string }>;
    };
    expect(written.profiles["default"]!.url).toBe(
      "https://different.example.test",
    );
    expect(written.profiles["default"]!.api_key).toBe(key);
  });

  it("targets a named profile when --profile is given", async () => {
    const { upsertProfile, readStore } = await import("../store.js");
    upsertProfile("prod", { url: "https://prod", apiKey: "pk_old" });
    upsertProfile("dev", { url: "https://dev", apiKey: "pk_dev" });
    const before = readStore();
    expect(before.currentProfile).toBe("prod");

    const key = "pane_" + "9".repeat(32);
    await run([key, "--profile", "dev"]);
    const after = readStore();
    expect(after.currentProfile).toBe("prod"); // unchanged
    expect(after.profiles["dev"]!.apiKey).toBe(key);
    expect(after.profiles["prod"]!.apiKey).toBe("pk_old"); // untouched
  });

  it("never echoes the key in stdout", async () => {
    const key = "pane_" + "d".repeat(32);
    await run([key]);
    expect(stdout).not.toContain(key);
    expect(stdout).toContain("key_prefix");
  });

  it("fails on missing positional arg", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing api-key");
  });

  it("rejects whitespace-padded keys to catch copy-paste errors", async () => {
    const key = "  pane_" + "e".repeat(32) + "  ";
    await run([key]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("whitespace");
  });

  it("rejects unknown flags", async () => {
    await expect(
      runSetKey(argv(["pane_" + "f".repeat(32), "--bogus", "x"])),
    ).rejects.toThrow("unknown flag(s): --bogus");
  });
});
