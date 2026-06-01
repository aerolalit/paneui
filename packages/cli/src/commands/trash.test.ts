// Tests for `pane trash` — list, restore, restore-template, purge,
// purge-template.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  listTrash: vi.fn(() => {
    calls.push({ method: "listTrash", args: [] });
    return Promise.resolve({
      panes: [
        {
          pane_id: "pan_x",
          title: "t",
          agent_name: "a",
          deleted_at: "2026-01-01T00:00:00Z",
        },
      ],
      templates: [],
    });
  }),
  restorePane: vi.fn((id: unknown) => {
    calls.push({ method: "restorePane", args: [id] });
    return Promise.resolve();
  }),
  restoreTemplate: vi.fn((id: unknown) => {
    calls.push({ method: "restoreTemplate", args: [id] });
    return Promise.resolve();
  }),
  permanentDeletePane: vi.fn((id: unknown) => {
    calls.push({ method: "permanentDeletePane", args: [id] });
    return Promise.resolve();
  }),
  permanentDeleteTemplate: vi.fn((id: unknown) => {
    calls.push({ method: "permanentDeleteTemplate", args: [id] });
    return Promise.resolve();
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runTrash } from "./trash.js";
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
    await runTrash(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("pane trash list", () => {
  it("calls listTrash and prints the response", async () => {
    await run(["list"]);
    expect(calls).toEqual([{ method: "listTrash", args: [] }]);
    const out = JSON.parse(stdout);
    expect(out.panes).toHaveLength(1);
    expect(out.panes[0].pane_id).toBe("pan_x");
  });
});

describe("pane trash restore", () => {
  it("restores the given pane id", async () => {
    await run(["restore", "pan_abc"]);
    expect(calls).toEqual([{ method: "restorePane", args: ["pan_abc"] }]);
    expect(JSON.parse(stdout)).toEqual({
      pane_id: "pan_abc",
      restored: true,
    });
  });

  it("fails when the pane id is missing", async () => {
    await run(["restore"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("missing <pane-id>");
    expect(calls).toHaveLength(0);
  });
});

describe("pane trash restore-template", () => {
  it("restores the given template id-or-slug", async () => {
    await run(["restore-template", "my-tpl"]);
    expect(calls).toEqual([{ method: "restoreTemplate", args: ["my-tpl"] }]);
    expect(JSON.parse(stdout)).toEqual({
      template_id: "my-tpl",
      restored: true,
    });
  });
});

describe("pane trash purge", () => {
  it("permanently hard-deletes the given pane id", async () => {
    await run(["purge", "pan_abc"]);
    expect(calls).toEqual([
      { method: "permanentDeletePane", args: ["pan_abc"] },
    ]);
    expect(JSON.parse(stdout)).toEqual({
      pane_id: "pan_abc",
      purged: true,
    });
  });

  it("fails when the pane id is missing", async () => {
    await run(["purge"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });
});

describe("pane trash purge-template", () => {
  it("permanently hard-deletes the given template id-or-slug", async () => {
    await run(["purge-template", "my-tpl"]);
    expect(calls).toEqual([
      { method: "permanentDeleteTemplate", args: ["my-tpl"] },
    ]);
    expect(JSON.parse(stdout)).toEqual({
      template_id: "my-tpl",
      purged: true,
    });
  });
});

describe("pane trash — unknown verb", () => {
  it("fails with invalid_args on an unknown verb", async () => {
    await run(["nonsense"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("unknown trash verb");
    expect(calls).toHaveLength(0);
  });

  it("prints help on --help with no verb", async () => {
    await run([]);
    // No client method invoked.
    expect(calls).toHaveLength(0);
    expect(stdout).toContain("pane trash — manage the soft-delete trash");
  });
});
