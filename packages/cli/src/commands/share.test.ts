// Tests for `pane share` — arg parsing + dispatch to the right client method.
// Mirrors the harness in state.test.ts (fake client, captured stderr/exit).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  listGrants: vi.fn((id: unknown) => {
    calls.push({ method: "listGrants", args: [id] });
    return Promise.resolve({ pane_id: id, is_public: false, items: [] });
  }),
  createGrant: vi.fn((id: unknown, opts: unknown) => {
    calls.push({ method: "createGrant", args: [id, opts] });
    return Promise.resolve({
      id: "grant_1",
      human_id: null,
      invite_email: "x@example.com",
      role: "participant",
      accepted_at: null,
    });
  }),
  revokeGrant: vi.fn((id: unknown, gid: unknown) => {
    calls.push({ method: "revokeGrant", args: [id, gid] });
    return Promise.resolve();
  }),
  setPaneVisibility: vi.fn((id: unknown, pub: unknown) => {
    calls.push({ method: "setPaneVisibility", args: [id, pub] });
    return Promise.resolve({ pane_id: id, is_public: pub });
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runShare } from "./share.js";
import { parseArgs } from "../argv.js";

// Mirror index.ts BOOLEAN_FLAGS so the parser treats --public/--private/--list
// as booleans (not value-flags).
const BOOLS = new Set([
  "json",
  "once",
  "help",
  "print-key",
  "yes",
  "plain",
  "public",
  "private",
  "list",
]);
function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  calls.length = 0;
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
  vi.restoreAllMocks();
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runShare(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("pane share", () => {
  it("--list calls listGrants", async () => {
    await run(["pan_abc", "--list"]);
    expect(exitCode).toBeUndefined();
    expect(calls[0]!.method).toBe("listGrants");
    expect(calls[0]!.args[0]).toBe("pan_abc");
  });

  it("--email defaults role to participant (omitted in client call)", async () => {
    await run(["pan_abc", "--email", "x@example.com"]);
    expect(calls[0]!.method).toBe("createGrant");
    expect(calls[0]!.args[1]).toEqual({ email: "x@example.com" });
  });

  it("--email --role viewer passes the role through", async () => {
    await run(["pan_abc", "--email", "x@example.com", "--role", "viewer"]);
    expect(calls[0]!.args[1]).toEqual({
      email: "x@example.com",
      role: "viewer",
    });
  });

  it("rejects an invalid --role", async () => {
    await run(["pan_abc", "--email", "x@example.com", "--role", "admin"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("--public calls setPaneVisibility(true)", async () => {
    await run(["pan_abc", "--public"]);
    expect(calls[0]!.method).toBe("setPaneVisibility");
    expect(calls[0]!.args[1]).toBe(true);
  });

  it("--private calls setPaneVisibility(false)", async () => {
    await run(["pan_abc", "--private"]);
    expect(calls[0]!.method).toBe("setPaneVisibility");
    expect(calls[0]!.args[1]).toBe(false);
  });

  it("--revoke calls revokeGrant", async () => {
    await run(["pan_abc", "--revoke", "grant_1"]);
    expect(calls[0]!.method).toBe("revokeGrant");
    expect(calls[0]!.args).toEqual(["pan_abc", "grant_1"]);
  });

  it("missing pane id fails", async () => {
    await run(["--list"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid_args");
  });

  it("missing verb fails", async () => {
    await run(["pan_abc"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing verb");
  });

  it("ambiguous (two verbs) fails", async () => {
    await run(["pan_abc", "--public", "--list"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ambiguous");
  });
});
