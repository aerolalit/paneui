// Tests for `pane keys` — subcommand dispatch, key display, revoke guard.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const keyInfo = {
  agent_id: "agt_me",
  name: "my-agent",
  key_prefix: "pk_abc1234",
  created_at: "2026-01-01T00:00:00.000Z",
  last_used_at: "2026-01-02T00:00:00.000Z",
  revoked_at: null,
};
const fakeClient = {
  listKeys: vi.fn(() => {
    calls.push({ method: "listKeys", args: [] });
    return Promise.resolve(keyInfo);
  }),
  revokeKey: vi.fn((id: unknown) => {
    calls.push({ method: "revokeKey", args: [id] });
    return Promise.resolve();
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runKeys } from "./keys.js";
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runKeys(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runKeys dispatch", () => {
  it("rejects a missing subcommand", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("missing subcommand");
  });

  it("rejects an unknown subcommand", async () => {
    await run(["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown keys subcommand");
  });
});

describe("keys list", () => {
  it("prints the caller's own key info", async () => {
    await run(["list"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("listKeys");
    expect(JSON.parse(stdout)).toEqual(keyInfo);
  });
});

describe("keys revoke", () => {
  it("refuses without --yes and does not call the relay", async () => {
    await run(["revoke"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("confirmation_required");
    expect(stderr).toContain("--yes");
    expect(calls).toHaveLength(0);
  });

  it("revokes the caller's own key when --yes is given", async () => {
    await run(["revoke", "--yes"]);
    // resolves own id via listKeys, then revokes it
    expect(calls.map((c) => c.method)).toEqual(["listKeys", "revokeKey"]);
    expect(calls[1]!.args[0]).toBe("agt_me");
    expect(JSON.parse(stdout)).toEqual({ revoked: true, agent_id: "agt_me" });
  });

  it("passes a positional id through to the relay when given", async () => {
    await run(["revoke", "agt_other", "--yes"]);
    expect(calls.map((c) => c.method)).toEqual(["revokeKey"]);
    expect(calls[0]!.args[0]).toBe("agt_other");
    expect(JSON.parse(stdout)).toEqual({
      revoked: true,
      agent_id: "agt_other",
    });
  });
});
