// Tests for `pane blob` — subcommand dispatch + arg validation + the
// happy path for each subcommand. Mocks `makeClient` to record what
// PaneClient method got called with what args; asserts on the JSON
// printed to stdout and the error envelope written to stderr.
//
// Pattern mirrors taste.test.ts / feedback.test.ts. The CLI's job is
// arg parsing + dispatch + JSON I/O; transport correctness lives in
// @paneui/core's PaneClient tests and the relay's e2e suite.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RecordedCall {
  method: string;
  args: unknown[];
}

const calls: RecordedCall[] = [];

const sampleBlobRef = {
  blob_id: "cmpfblob1234567890abc",
  scope: "agent" as const,
  mime: "image/jpeg",
  size: 1234,
  sha256: "a".repeat(64),
  url: "http://relay.test/v1/blobs/cmpfblob1234567890abc",
  width: 64,
  height: 64,
  filename: "test.jpg",
  status: "ready",
  session_id: null,
  artifact_id: null,
  created_at: "2026-05-21T00:00:00.000Z",
  confirmed_at: "2026-05-21T00:00:00.000Z",
  deleted_at: null,
};

const sampleTokenMint = {
  token_id: "cmptok1234567890",
  token: "paneb_AAAABBBBCCCCDDDDEEEEFFFF11112222",
  token_prefix: "paneb_AAAA",
  url: "http://relay.test/b/paneb_AAAABBBBCCCCDDDDEEEEFFFF11112222",
  expires_at: "2026-05-22T00:00:00.000Z",
  once: false,
};

const fakeClient = {
  uploadBlob: vi.fn(async (file: unknown, opts: unknown) => {
    calls.push({ method: "uploadBlob", args: [file, opts] });
    return sampleBlobRef;
  }),
  downloadBlob: vi.fn(async (blobId: string) => {
    calls.push({ method: "downloadBlob", args: [blobId] });
    // Tiny deterministic payload for the round-trip test.
    return new Uint8Array([1, 2, 3, 4, 5]).buffer;
  }),
  getBlob: vi.fn(async (blobId: string) => {
    calls.push({ method: "getBlob", args: [blobId] });
    return sampleBlobRef;
  }),
  deleteBlob: vi.fn(async (blobId: string) => {
    calls.push({ method: "deleteBlob", args: [blobId] });
    return { deleted: true as const };
  }),
  mintBlobToken: vi.fn(async (blobId: string, opts: unknown) => {
    calls.push({ method: "mintBlobToken", args: [blobId, opts] });
    return sampleTokenMint;
  }),
  revokeBlobToken: vi.fn(async (blobId: string, tokenId: string) => {
    calls.push({ method: "revokeBlobToken", args: [blobId, tokenId] });
    return { token_id: tokenId, revoked: true as const };
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runBlob } from "./blob.js";
import { parseArgs } from "../argv.js";

// Same BOOLS set the CLI's argv parser uses globally. `once` is the only
// blob-specific bool flag; the rest are shared with other commands.
const BOOLS = new Set(["json", "once", "help", "print-key", "yes"]);

function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let stdout: string;
let stderr: string;
let exitCode: number | undefined;
let tmpDir: string;

beforeEach(() => {
  calls.length = 0;
  stdout = "";
  stderr = "";
  exitCode = undefined;
  tmpDir = mkdtempSync(join(tmpdir(), "pane-blob-cli-test-"));
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
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runBlob(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

function writeFixture(name: string, content: string | Uint8Array): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  return path;
}

// ===========================================================================
// Dispatch
// ===========================================================================

describe("runBlob dispatch", () => {
  it("rejects a missing subcommand", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error;
    expect(err.code).toBe("invalid_args");
    expect(err.message).toContain("missing subcommand");
  });

  it("rejects an unknown subcommand", async () => {
    await run(["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown blob subcommand");
  });
});

// ===========================================================================
// upload
// ===========================================================================

describe("pane blob upload", () => {
  it("rejects when --file is missing", async () => {
    await run(["upload"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing --file");
    expect(calls).toHaveLength(0);
  });

  it("rejects when --file points at a non-existent path", async () => {
    await run(["upload", "--file", "/tmp/__does_not_exist_xyz__.bin"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("failed to read --file");
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown --scope value", async () => {
    const f = writeFixture("a.txt", "hi");
    await run(["upload", "--file", f, "--scope", "nonsense"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown --scope");
    expect(calls).toHaveLength(0);
  });

  it("rejects --scope=session without --session-id", async () => {
    const f = writeFixture("a.txt", "hi");
    await run(["upload", "--file", f, "--scope", "session"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires --session-id");
    expect(calls).toHaveLength(0);
  });

  it("rejects --scope=artifact without --artifact-id", async () => {
    const f = writeFixture("a.txt", "hi");
    await run(["upload", "--file", f, "--scope", "artifact"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires --artifact-id");
    expect(calls).toHaveLength(0);
  });

  it("happy path: agent scope, prints the BlobRef", async () => {
    const f = writeFixture("photo.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0]));
    await run(["upload", "--file", f]);
    expect(exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("uploadBlob");
    const opts = calls[0]!.args[1] as Record<string, unknown>;
    expect(opts.scope).toBe("agent");
    expect(opts.sessionId).toBeUndefined();
    expect(opts.artifactId).toBeUndefined();
    expect(opts.filename).toBe("photo.jpg"); // basename of --file
    expect(JSON.parse(stdout).blob_id).toBe(sampleBlobRef.blob_id);
  });

  it("happy path: session scope passes session_id and scope through", async () => {
    const f = writeFixture("a.bin", "x");
    await run([
      "upload",
      "--file",
      f,
      "--scope",
      "session",
      "--session-id",
      "ses_xyz",
    ]);
    expect(calls).toHaveLength(1);
    const opts = calls[0]!.args[1] as Record<string, unknown>;
    expect(opts.scope).toBe("session");
    expect(opts.sessionId).toBe("ses_xyz");
  });

  it("happy path: artifact scope passes artifact_id and scope through", async () => {
    const f = writeFixture("a.bin", "x");
    await run([
      "upload",
      "--file",
      f,
      "--scope",
      "artifact",
      "--artifact-id",
      "cmpfartifact1",
    ]);
    expect(calls).toHaveLength(1);
    const opts = calls[0]!.args[1] as Record<string, unknown>;
    expect(opts.scope).toBe("artifact");
    expect(opts.artifactId).toBe("cmpfartifact1");
  });

  it("--filename overrides the file basename", async () => {
    const f = writeFixture("ugly-temp-name.bin", "x");
    await run(["upload", "--file", f, "--filename", "pretty.jpg"]);
    const opts = calls[0]!.args[1] as Record<string, unknown>;
    expect(opts.filename).toBe("pretty.jpg");
  });

  it("--mime is forwarded to the client", async () => {
    const f = writeFixture("a.bin", "x");
    await run(["upload", "--file", f, "--mime", "image/png"]);
    const opts = calls[0]!.args[1] as Record<string, unknown>;
    expect(opts.mime).toBe("image/png");
  });
});

// ===========================================================================
// download
// ===========================================================================

describe("pane blob download", () => {
  it("rejects when <blob_id> is missing", async () => {
    await run(["download"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <blob_id>");
    expect(calls).toHaveLength(0);
  });

  it("--out writes the bytes to disk + prints a summary", async () => {
    const outPath = join(tmpDir, "out.bin");
    await run(["download", "cmpf123", "--out", outPath]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("downloadBlob");
    expect(calls[0]!.args[0]).toBe("cmpf123");
    const written = readFileSync(outPath);
    expect(Array.from(written)).toEqual([1, 2, 3, 4, 5]);
    const summary = JSON.parse(stdout);
    expect(summary.blob_id).toBe("cmpf123");
    expect(summary.written).toBe(outPath);
    expect(summary.bytes).toBe(5);
  });

  it("no --out writes binary directly to stdout", async () => {
    await run(["download", "cmpf123"]);
    expect(calls).toHaveLength(1);
    // stdout was captured as a string; the 5 binary bytes round-trip as
    // the same code points.
    expect(stdout.length).toBe(5);
  });
});

// ===========================================================================
// show
// ===========================================================================

describe("pane blob show", () => {
  it("rejects when <blob_id> is missing", async () => {
    await run(["show"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <blob_id>");
    expect(calls).toHaveLength(0);
  });

  it("prints the BlobRef from the relay", async () => {
    await run(["show", "cmpf123"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("getBlob");
    expect(calls[0]!.args[0]).toBe("cmpf123");
    expect(JSON.parse(stdout).blob_id).toBe(sampleBlobRef.blob_id);
  });
});

// ===========================================================================
// delete
// ===========================================================================

describe("pane blob delete", () => {
  it("rejects when <blob_id> is missing", async () => {
    await run(["delete"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <blob_id>");
    expect(calls).toHaveLength(0);
  });

  it("prints { blob_id, deleted: true } on success", async () => {
    await run(["delete", "cmpf123"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("deleteBlob");
    expect(calls[0]!.args[0]).toBe("cmpf123");
    const out = JSON.parse(stdout);
    expect(out).toEqual({ blob_id: "cmpf123", deleted: true });
  });
});

// ===========================================================================
// mint-token
// ===========================================================================

describe("pane blob mint-token", () => {
  it("rejects when <blob_id> is missing", async () => {
    await run(["mint-token"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <blob_id>");
    expect(calls).toHaveLength(0);
  });

  it("rejects --ttl that isn't a positive integer", async () => {
    await run(["mint-token", "cmpf123", "--ttl", "-5"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("positive integer");
    expect(calls).toHaveLength(0);
  });

  it("rejects --ttl=0", async () => {
    await run(["mint-token", "cmpf123", "--ttl", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("positive integer");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-numeric --ttl", async () => {
    await run(["mint-token", "cmpf123", "--ttl", "soon"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("positive integer");
    expect(calls).toHaveLength(0);
  });

  it("happy path with defaults: no ttl, once=false", async () => {
    await run(["mint-token", "cmpf123"]);
    expect(calls).toHaveLength(1);
    const [blobId, opts] = calls[0]!.args as [string, Record<string, unknown>];
    expect(blobId).toBe("cmpf123");
    expect(opts.ttlSeconds).toBeUndefined();
    expect(opts.once).toBe(false);
    expect(JSON.parse(stdout).token).toBe(sampleTokenMint.token);
  });

  it("forwards --ttl and --once", async () => {
    await run(["mint-token", "cmpf123", "--ttl", "3600", "--once"]);
    expect(calls).toHaveLength(1);
    const [, opts] = calls[0]!.args as [string, Record<string, unknown>];
    expect(opts.ttlSeconds).toBe(3600);
    expect(opts.once).toBe(true);
  });
});

// ===========================================================================
// revoke-token
// ===========================================================================

describe("pane blob revoke-token", () => {
  it("rejects when either positional is missing", async () => {
    await run(["revoke-token"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing arguments");
    expect(calls).toHaveLength(0);
  });

  it("rejects when only one positional is given", async () => {
    await run(["revoke-token", "cmpf123"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing arguments");
    expect(calls).toHaveLength(0);
  });

  it("prints { token_id, revoked: true } on success", async () => {
    await run(["revoke-token", "cmpf123", "cmptok456"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("revokeBlobToken");
    expect(calls[0]!.args).toEqual(["cmpf123", "cmptok456"]);
    const out = JSON.parse(stdout);
    expect(out).toEqual({ token_id: "cmptok456", revoked: true });
  });
});
