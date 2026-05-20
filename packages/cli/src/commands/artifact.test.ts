// Tests for `pane artifact` — subcommand dispatch and request assembly.
//
// The relay client is stubbed via vi.mock on ../config.js, so each test
// asserts what request the subcommand WOULD send. process.exit / stdout /
// stderr are captured so a fail() does not abort the test run.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A recording fake of the bits of PaneClient the artifact command uses.
const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  createArtifact: vi.fn((req: unknown) => {
    calls.push({ method: "createArtifact", args: [req] });
    return Promise.resolve({ artifact_id: "art_1", version: 1 });
  }),
  createArtifactVersion: vi.fn((id: unknown, req: unknown) => {
    calls.push({ method: "createArtifactVersion", args: [id, req] });
    return Promise.resolve({ artifact_id: "art_1", version: 2 });
  }),
  updateArtifact: vi.fn((id: unknown, meta: unknown) => {
    calls.push({ method: "updateArtifact", args: [id, meta] });
    return Promise.resolve({ id: "art_1", name: "Renamed" });
  }),
  searchArtifacts: vi.fn((q: unknown) => {
    calls.push({ method: "searchArtifacts", args: [q] });
    return Promise.resolve([{ id: "art_1", slug: "pr-review" }]);
  }),
  getArtifact: vi.fn((id: unknown) => {
    calls.push({ method: "getArtifact", args: [id] });
    return Promise.resolve({ id: "art_1", versions: [] });
  }),
  deleteArtifact: vi.fn((id: unknown) => {
    calls.push({ method: "deleteArtifact", args: [id] });
    return Promise.resolve();
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runArtifact } from "./artifact.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes"]);

/** Build ParsedArgs from raw tokens, as index.ts does. */
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
  // fail() calls process.exit(1); throw instead so the test can catch it.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run a command, swallowing the synthetic exit throw from fail(). */
async function run(tokens: string[]): Promise<void> {
  try {
    await runArtifact(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runArtifact dispatch", () => {
  it("rejects a missing subcommand", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("missing subcommand");
  });

  it("rejects an unknown subcommand", async () => {
    await run(["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown artifact subcommand");
  });
});

describe("artifact create", () => {
  it("assembles a create request from flags", async () => {
    await run([
      "create",
      "--name",
      "PR Review",
      "--slug",
      "pr-review",
      "--description",
      "review a PR",
      "--tags",
      "pr, review ,code",
      "--artifact",
      "<html></html>",
      "--event-schema",
      '{"events":{}}',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("createArtifact");
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req).toMatchObject({
      name: "PR Review",
      slug: "pr-review",
      description: "review a PR",
      tags: ["pr", "review", "code"],
      type: "html-inline",
    });
    expect(req["source"]).toBe("<html></html>");
    expect(JSON.parse(stdout)).toEqual({
      artifact_id: "art_1",
      slug: "pr-review",
      version: 1,
    });
  });

  it("parses --input-schema as a JSON object", async () => {
    await run([
      "create",
      "--name",
      "Form",
      "--artifact",
      "<html></html>",
      "--event-schema",
      '{"events":{}}',
      "--input-schema",
      '{"type":"object"}',
    ]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req["input_schema"]).toEqual({ type: "object" });
  });

  it("fails when --name is missing", async () => {
    await run([
      "create",
      "--artifact",
      "<html></html>",
      "--event-schema",
      "{}",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing --name");
    expect(calls).toHaveLength(0);
  });

  it("creates a view-only artifact when --event-schema is omitted", async () => {
    await run(["create", "--name", "X", "--artifact", "<html></html>"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("createArtifact");
    const req = calls[0]!.args[0] as Record<string, unknown>;
    // event_schema must be ABSENT, not set to undefined.
    expect("event_schema" in req).toBe(false);
    expect(req).toMatchObject({ name: "X", type: "html-inline" });
  });
});

describe("artifact version", () => {
  it("appends a version to the given id/slug", async () => {
    await run([
      "version",
      "pr-review",
      "--artifact",
      "<html>v2</html>",
      "--event-schema",
      '{"events":{}}',
    ]);
    expect(calls[0]!.method).toBe("createArtifactVersion");
    expect(calls[0]!.args[0]).toBe("pr-review");
    expect(JSON.parse(stdout)).toEqual({ artifact_id: "art_1", version: 2 });
  });

  it("fails when the id/slug positional is missing", async () => {
    await run([
      "version",
      "--artifact",
      "<html></html>",
      "--event-schema",
      "{}",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing artifact <id|slug>");
  });

  it("appends a view-only version when --event-schema is omitted", async () => {
    await run(["version", "pr-review", "--artifact", "<html>v2</html>"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("createArtifactVersion");
    const req = calls[0]!.args[1] as Record<string, unknown>;
    // event_schema must be ABSENT, not set to undefined.
    expect("event_schema" in req).toBe(false);
    expect(req).toMatchObject({ type: "html-inline" });
  });
});

describe("artifact update", () => {
  it("sends only the provided metadata fields", async () => {
    await run(["update", "art_1", "--name", "Renamed", "--tags", "a,b"]);
    expect(calls[0]!.method).toBe("updateArtifact");
    expect(calls[0]!.args[0]).toBe("art_1");
    expect(calls[0]!.args[1]).toEqual({ name: "Renamed", tags: ["a", "b"] });
  });

  it("fails when no metadata flag is given", async () => {
    await run(["update", "art_1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("nothing to update");
  });
});

describe("artifact search / list", () => {
  it("search passes the query positional", async () => {
    await run(["search", "review"]);
    expect(calls[0]!.method).toBe("searchArtifacts");
    expect(calls[0]!.args[0]).toBe("review");
    expect(JSON.parse(stdout)).toEqual([{ id: "art_1", slug: "pr-review" }]);
  });

  it("list calls search with no query", async () => {
    await run(["list"]);
    expect(calls[0]!.method).toBe("searchArtifacts");
    expect(calls[0]!.args[0]).toBeUndefined();
  });
});

describe("artifact show", () => {
  it("fetches the full artifact by id/slug", async () => {
    await run(["show", "pr-review"]);
    expect(calls[0]!.method).toBe("getArtifact");
    expect(calls[0]!.args[0]).toBe("pr-review");
  });

  it("fails when the id/slug positional is missing", async () => {
    await run(["show"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing artifact <id|slug>");
  });
});

describe("artifact delete (#137)", () => {
  it("calls deleteArtifact when --yes is given", async () => {
    await run(["delete", "pr-review", "--yes"]);
    expect(calls[0]!.method).toBe("deleteArtifact");
    expect(calls[0]!.args[0]).toBe("pr-review");
    expect(JSON.parse(stdout)).toEqual({
      artifact: "pr-review",
      deleted: true,
    });
  });

  it("refuses without --yes (destructive guard)", async () => {
    // No relay call should fire — the CLI rejects locally so a typo
    // can't accidentally drop a real artifact.
    await run(["delete", "pr-review"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--yes");
    expect(calls).toHaveLength(0);
  });

  it("fails when the id/slug positional is missing", async () => {
    await run(["delete", "--yes"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing artifact <id|slug>");
    expect(calls).toHaveLength(0);
  });
});

describe("artifact unknown subcommand", () => {
  it("lists 'delete' in the error message (so users learn it exists)", async () => {
    await run(["nope"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("delete");
  });
});
