// Tests for `pane agent` — the noun-level dispatcher.
//
// The verb runners (runRegister / runLogout) have their own tests. This
// file pins the dispatch contract: register / logout route correctly,
// missing or unknown verbs fail loudly.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./agent.js";
import { parseArgs } from "../argv.js";
import { writeStore, storePath } from "../store.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes"]);
function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let dir: string;
let savedXdg: string | undefined;
let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-agent-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  stderr = "";
  exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += String(s);
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
  vi.restoreAllMocks();
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runAgent(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runAgent dispatch", () => {
  it("rejects a missing verb", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("invalid_args");
    expect(err.message).toContain("missing verb");
  });

  it("rejects an unknown verb", async () => {
    await run(["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown agent verb");
  });

  it("routes `logout` to runLogout — clears the store", async () => {
    // Seed the store, then prove `pane agent logout` empties it. The
    // bigger logout behaviour lives in logout.test; here we only need to
    // see that the dispatcher routed to runLogout at all.
    writeStore({ url: "https://relay.test", apiKey: "pk_test" });
    expect(existsSync(storePath())).toBe(true);
    await run(["logout"]);
    expect(exitCode).toBeUndefined();
    expect(existsSync(storePath())).toBe(false);
  });
});
