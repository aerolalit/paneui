// Tests for `pane taste` — subcommand dispatch, set's input requirements,
// and the clear --yes confirmation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: { method: string; args: unknown[] }[] = [];
const tasteInfo = {
  taste: "- denser",
  updated_at: "2026-05-20T00:00:00.000Z",
  bytes: 8,
};
const fakeClient = {
  getTaste: vi.fn(() => {
    calls.push({ method: "getTaste", args: [] });
    return Promise.resolve(tasteInfo);
  }),
  setTaste: vi.fn((taste: unknown) => {
    calls.push({ method: "setTaste", args: [taste] });
    return Promise.resolve({ ...tasteInfo, taste: String(taste) });
  }),
  clearTaste: vi.fn(() => {
    calls.push({ method: "clearTaste", args: [] });
    return Promise.resolve();
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runTaste } from "./taste.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes"]);

function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let stdout: string;
let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  calls.length = 0;
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
  // Pretend stdin is a TTY by default so "set" without --file is rejected
  // unless an individual test overrides it.
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    get: () => true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runTaste(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runTaste dispatch", () => {
  it("rejects a missing subcommand", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("missing subcommand");
  });

  it("rejects an unknown subcommand", async () => {
    await run(["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown taste subcommand");
  });
});

describe("taste get", () => {
  it("prints the current notes blob as JSON", async () => {
    await run(["get"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("getTaste");
    expect(JSON.parse(stdout)).toEqual(tasteInfo);
  });
});

describe("taste set", () => {
  it("refuses without stdin or --file", async () => {
    await run(["set"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("pipe markdown on stdin or pass --file");
    expect(calls).toHaveLength(0);
  });

  it("reads from --file and PUTs the contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taste-test-"));
    const file = join(dir, "taste.md");
    writeFileSync(file, "- denser\n- no rounded corners\n", "utf8");
    try {
      await run(["set", "--file", file]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("setTaste");
      expect(calls[0]!.args[0]).toBe("- denser\n- no rounded corners\n");
      expect(JSON.parse(stdout).taste).toBe("- denser\n- no rounded corners\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an empty --file blob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taste-test-"));
    const file = join(dir, "empty.md");
    writeFileSync(file, "   \n\t  \n", "utf8");
    try {
      await run(["set", "--file", file]);
      expect(exitCode).toBe(1);
      expect(JSON.parse(stderr).error.code).toBe("invalid_args");
      expect(stderr).toContain("empty");
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("taste clear", () => {
  it("refuses without --yes and does not call the relay", async () => {
    await run(["clear"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("confirmation_required");
    expect(stderr).toContain("--yes");
    expect(calls).toHaveLength(0);
  });

  it("clears the notes when --yes is given", async () => {
    await run(["clear", "--yes"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("clearTaste");
    expect(JSON.parse(stdout)).toEqual({ cleared: true });
  });
});
