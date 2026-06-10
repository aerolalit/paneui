// Tests for `pane template` — subcommand dispatch and request assembly.
//
// The relay client is stubbed via vi.mock on ../config.js, so each test
// asserts what request the subcommand WOULD send. process.exit / stdout /
// stderr are captured so a fail() does not abort the test run.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A recording fake of the bits of PaneClient the template command uses.
const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  createArtifact: vi.fn((req: unknown) => {
    calls.push({ method: "createArtifact", args: [req] });
    return Promise.resolve({ template_id: "art_1", version: 1 });
  }),
  createArtifactVersion: vi.fn((id: unknown, req: unknown) => {
    calls.push({ method: "createArtifactVersion", args: [id, req] });
    return Promise.resolve({ template_id: "art_1", version: 2 });
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
  publishTemplate: vi.fn((id: unknown, body: unknown) => {
    calls.push({ method: "publishTemplate", args: [id, body] });
    return Promise.resolve({
      id: "art_1",
      slug: "x",
      name: "X",
      published_at: "2026-01-01T00:00:00.000Z",
      scopes: [],
      install_count: 0,
    });
  }),
  unpublishTemplate: vi.fn((id: unknown) => {
    calls.push({ method: "unpublishTemplate", args: [id] });
    return Promise.resolve({ id: "art_1", published_at: null });
  }),
  searchPublicTemplates: vi.fn((q: unknown, opts: unknown) => {
    calls.push({ method: "searchPublicTemplates", args: [q, opts] });
    return Promise.resolve({ items: [], total: 0, offset: 0, limit: 25 });
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runTemplate } from "./template.js";
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
    await runTemplate(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runTemplate dispatch", () => {
  it("rejects a missing subcommand", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("missing subcommand");
  });

  it("rejects an unknown subcommand", async () => {
    await run(["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown template subcommand");
  });
});

describe("template create", () => {
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
      "--template",
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
      template_id: "art_1",
      slug: "pr-review",
      version: 1,
    });
  });

  it("parses --input-schema as a JSON object", async () => {
    await run([
      "create",
      "--name",
      "Form",
      "--template",
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
      "--template",
      "<html></html>",
      "--event-schema",
      "{}",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing --name");
    expect(calls).toHaveLength(0);
  });

  it("creates a view-only template when --event-schema is omitted", async () => {
    await run(["create", "--name", "X", "--template", "<html></html>"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("createArtifact");
    const req = calls[0]!.args[0] as Record<string, unknown>;
    // event_schema must be ABSENT, not set to undefined.
    expect("event_schema" in req).toBe(false);
    expect(req).toMatchObject({ name: "X", type: "html-inline" });
  });

  // --record-schema declares the template's per-pane record collections
  // (#476). Optional; absent = event-only template.
  it("parses --record-schema as a JSON object and forwards it as record_schema", async () => {
    const recordSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      "x-pane-collections": {
        todos: {
          schema: { $ref: "#/$defs/Todo" },
          write: ["page"],
          delete: ["author"],
        },
      },
    };
    await run([
      "create",
      "--name",
      "Todo list",
      "--template",
      "<html></html>",
      "--record-schema",
      JSON.stringify(recordSchema),
    ]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req["record_schema"]).toEqual(recordSchema);
  });

  it("rejects a non-object --record-schema (array/primitive)", async () => {
    await run([
      "create",
      "--name",
      "X",
      "--template",
      "<html></html>",
      "--record-schema",
      "[]",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--record-schema must be a JSON object");
    expect(calls).toHaveLength(0);
  });

  it("omits record_schema when --record-schema is absent (event-only template)", async () => {
    await run(["create", "--name", "X", "--template", "<html></html>"]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    // record_schema must be ABSENT, not set to undefined.
    expect("record_schema" in req).toBe(false);
  });

  // --template-record-schema declares the template's TEMPLATE-level (shared
  // across all panes) record collections (#509). Optional; absent = no
  // template-level collections.
  it("parses --template-record-schema as a JSON object and forwards it as template_record_schema", async () => {
    const templateRecordSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      "x-pane-collections": {
        roster: {
          schema: { $ref: "#/$defs/Member" },
          write: ["agent"],
          delete: ["author"],
        },
      },
    };
    await run([
      "create",
      "--name",
      "Team roster",
      "--template",
      "<html></html>",
      "--template-record-schema",
      JSON.stringify(templateRecordSchema),
    ]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req["template_record_schema"]).toEqual(templateRecordSchema);
  });

  it("rejects a non-object --template-record-schema (array/primitive)", async () => {
    await run([
      "create",
      "--name",
      "X",
      "--template",
      "<html></html>",
      "--template-record-schema",
      "[]",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--template-record-schema must be a JSON object");
    expect(calls).toHaveLength(0);
  });

  it("omits template_record_schema when --template-record-schema is absent", async () => {
    await run(["create", "--name", "X", "--template", "<html></html>"]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    // template_record_schema must be ABSENT, not set to undefined.
    expect("template_record_schema" in req).toBe(false);
  });
});

describe("template version", () => {
  it("appends a version to the given id/slug", async () => {
    await run([
      "version",
      "pr-review",
      "--template",
      "<html>v2</html>",
      "--event-schema",
      '{"events":{}}',
    ]);
    expect(calls[0]!.method).toBe("createArtifactVersion");
    expect(calls[0]!.args[0]).toBe("pr-review");
    expect(JSON.parse(stdout)).toEqual({ template_id: "art_1", version: 2 });
  });

  it("fails when the id/slug positional is missing", async () => {
    await run([
      "version",
      "--template",
      "<html></html>",
      "--event-schema",
      "{}",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing template <id|slug>");
  });

  it("appends a view-only version when --event-schema is omitted", async () => {
    await run(["version", "pr-review", "--template", "<html>v2</html>"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("createArtifactVersion");
    const req = calls[0]!.args[1] as Record<string, unknown>;
    // event_schema must be ABSENT, not set to undefined.
    expect("event_schema" in req).toBe(false);
    expect(req).toMatchObject({ type: "html-inline" });
  });

  // --record-schema on `template version` lets an author introduce (or
  // change) the record collections on a new version (#476). Pinned older
  // versions keep whatever schema they had.
  it("forwards --record-schema as record_schema on the new version", async () => {
    const recordSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      "x-pane-collections": {
        comments: {
          schema: { $ref: "#/$defs/Comment" },
          write: ["page"],
          delete: ["author"],
        },
      },
    };
    await run([
      "version",
      "pr-review",
      "--template",
      "<html>v2</html>",
      "--record-schema",
      JSON.stringify(recordSchema),
    ]);
    expect(calls[0]!.method).toBe("createArtifactVersion");
    const req = calls[0]!.args[1] as Record<string, unknown>;
    expect(req["record_schema"]).toEqual(recordSchema);
  });

  it("omits record_schema on the new version when --record-schema is absent", async () => {
    await run(["version", "pr-review", "--template", "<html>v2</html>"]);
    const req = calls[0]!.args[1] as Record<string, unknown>;
    expect("record_schema" in req).toBe(false);
  });

  // --template-record-schema on `template version` lets an author introduce
  // (or change) the TEMPLATE-level record collections on a new version
  // (#509). Pinned older versions keep whatever schema they had.
  it("forwards --template-record-schema as template_record_schema on the new version", async () => {
    const templateRecordSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      "x-pane-collections": {
        announcements: {
          schema: { $ref: "#/$defs/Announcement" },
          write: ["agent"],
          delete: ["author"],
        },
      },
    };
    await run([
      "version",
      "pr-review",
      "--template",
      "<html>v2</html>",
      "--template-record-schema",
      JSON.stringify(templateRecordSchema),
    ]);
    expect(calls[0]!.method).toBe("createArtifactVersion");
    const req = calls[0]!.args[1] as Record<string, unknown>;
    expect(req["template_record_schema"]).toEqual(templateRecordSchema);
  });

  it("omits template_record_schema on the new version when --template-record-schema is absent", async () => {
    await run(["version", "pr-review", "--template", "<html>v2</html>"]);
    const req = calls[0]!.args[1] as Record<string, unknown>;
    expect("template_record_schema" in req).toBe(false);
  });
});

describe("template update", () => {
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

describe("template search / list", () => {
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

describe("template show", () => {
  it("fetches the full template by id/slug", async () => {
    await run(["show", "pr-review"]);
    expect(calls[0]!.method).toBe("getArtifact");
    expect(calls[0]!.args[0]).toBe("pr-review");
  });

  it("fails when the id/slug positional is missing", async () => {
    await run(["show"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing template <id|slug>");
  });
});

describe("template delete (#137)", () => {
  it("calls deleteArtifact when --yes is given", async () => {
    await run(["delete", "pr-review", "--yes"]);
    expect(calls[0]!.method).toBe("deleteArtifact");
    expect(calls[0]!.args[0]).toBe("pr-review");
    expect(JSON.parse(stdout)).toEqual({
      template: "pr-review",
      deleted: true,
    });
  });

  it("refuses without --yes (destructive guard)", async () => {
    // No relay call should fire — the CLI rejects locally so a typo
    // can't accidentally drop a real template.
    await run(["delete", "pr-review"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--yes");
    expect(calls).toHaveLength(0);
  });

  it("fails when the id/slug positional is missing", async () => {
    await run(["delete", "--yes"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing template <id|slug>");
    expect(calls).toHaveLength(0);
  });
});

describe("template unknown subcommand", () => {
  it("lists 'delete' in the error message (so users learn it exists)", async () => {
    await run(["nope"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("delete");
  });
});

describe("template publish (#279 PR C)", () => {
  it("sends empty body when --scopes is omitted (server keeps existing)", async () => {
    await run(["publish", "pr-review"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      { method: "publishTemplate", args: ["pr-review", {}] },
    ]);
  });

  it("parses --scopes as a comma-separated array", async () => {
    await run(["publish", "pr-review", "--scopes", "read:agent, write:pane"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      {
        method: "publishTemplate",
        args: ["pr-review", { scopes: ["read:agent", "write:pane"] }],
      },
    ]);
  });

  it("sends scopes: [] when --scopes is the empty string (clear)", async () => {
    await run(["publish", "pr-review", "--scopes", ""]);
    expect(calls).toEqual([
      { method: "publishTemplate", args: ["pr-review", { scopes: [] }] },
    ]);
  });

  it("fails when the id/slug positional is missing", async () => {
    await run(["publish"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing template <id|slug>");
    expect(calls).toHaveLength(0);
  });
});

describe("template unpublish (#279 PR C)", () => {
  it("calls unpublishTemplate with the id", async () => {
    await run(["unpublish", "pr-review"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      { method: "unpublishTemplate", args: ["pr-review"] },
    ]);
  });

  it("fails when the id/slug positional is missing", async () => {
    await run(["unpublish"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing template <id|slug>");
    expect(calls).toHaveLength(0);
  });
});

describe("template search-public (#279 PR C)", () => {
  it("calls searchPublicTemplates with no query", async () => {
    await run(["search-public"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      { method: "searchPublicTemplates", args: [undefined, {}] },
    ]);
  });

  it("forwards the positional query", async () => {
    await run(["search-public", "pr review"]);
    expect(calls).toEqual([
      { method: "searchPublicTemplates", args: ["pr review", {}] },
    ]);
  });

  it("forwards --limit and --offset", async () => {
    await run(["search-public", "pr", "--limit", "10", "--offset", "20"]);
    expect(calls).toEqual([
      {
        method: "searchPublicTemplates",
        args: ["pr", { limit: 10, offset: 20 }],
      },
    ]);
  });

  it("rejects out-of-range --limit", async () => {
    await run(["search-public", "--limit", "100"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--limit must be an integer between 1 and 50");
    expect(calls).toHaveLength(0);
  });

  it("rejects negative --offset", async () => {
    await run(["search-public", "--offset", "-1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--offset must be a non-negative integer");
    expect(calls).toHaveLength(0);
  });
});
