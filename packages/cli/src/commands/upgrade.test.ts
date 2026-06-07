// Tests for `pane upgrade` — version targeting, --force, and validation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  upgradePane: vi.fn((id: unknown, opts: unknown) => {
    calls.push({ method: "upgradePane", args: [id, opts] });
    return Promise.resolve({
      pane_id: id,
      template_version_id: "tv_2",
      template_version: 2,
      upgraded: true,
      breaks: [],
      compat: "strict",
    });
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runUpgrade } from "./upgrade.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes", "force"]);

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runUpgrade(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runUpgrade", () => {
  it("upgrades to the latest version with no options", async () => {
    await run(["pan_abc"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("upgradePane");
    expect(calls[0]!.args[0]).toBe("pan_abc");
    expect(calls[0]!.args[1]).toEqual({});
    expect(JSON.parse(stdout)).toMatchObject({
      pane_id: "pan_abc",
      template_version: 2,
      upgraded: true,
    });
  });

  it("passes an explicit --template-version", async () => {
    await run(["pan_abc", "--template-version", "3"]);
    expect(calls[0]!.args[1]).toEqual({ template_version: 3 });
  });

  it("maps --force to compat=force", async () => {
    await run(["pan_abc", "--force"]);
    expect(calls[0]!.args[1]).toEqual({ compat: "force" });
  });

  it("combines --template-version and --force", async () => {
    await run(["pan_abc", "--template-version", "5", "--force"]);
    expect(calls[0]!.args[1]).toEqual({ template_version: 5, compat: "force" });
  });

  it("fails when the pane id is missing", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("missing <pane-id>");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-integer --template-version", async () => {
    await run(["pan_abc", "--template-version", "1.5"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("rejects a zero/negative --template-version", async () => {
    await run(["pan_abc", "--template-version", "0"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });
});
