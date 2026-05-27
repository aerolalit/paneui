// Tests for `pane attachment` — the noun-level dispatcher.
//
// The verb runners (runBlobUpload / runBlobDownload / runBlobList /
// runBlobToken / ...) have their own behaviour tested via the e2e relay
// suite. This file pins what the *dispatcher* does: peels off the attachment verb
// (and, for the token sub-noun, peels off "token" too), forwards a
// ParsedArgs shape the runner can handle, and errors out cleanly on missing
// / unknown verbs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We mock makeClient with a recording fake. listBlobs / listBlobTokens are
// the new verbs introduced here; mintBlobToken / revokeBlobToken / getBlob /
// deleteBlob are the existing ones we still need to assert dispatch for.
const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  listBlobs: vi.fn((opts: unknown) => {
    calls.push({ method: "listBlobs", args: [opts] });
    return Promise.resolve({ items: [], next_cursor: null });
  }),
  listBlobTokens: vi.fn((attachmentId: unknown) => {
    calls.push({ method: "listBlobTokens", args: [attachmentId] });
    return Promise.resolve({ attachment_id: attachmentId, items: [] });
  }),
  mintBlobToken: vi.fn((attachmentId: unknown, opts: unknown) => {
    calls.push({ method: "mintBlobToken", args: [attachmentId, opts] });
    return Promise.resolve({
      token_id: "tk_x",
      token: "plain",
      token_prefix: "plain_pref",
      url: "http://r/b/plain",
      expires_at: "2026-05-22T00:00:00.000Z",
      once: false,
    });
  }),
  revokeBlobToken: vi.fn((attachmentId: unknown, tokenId: unknown) => {
    calls.push({ method: "revokeBlobToken", args: [attachmentId, tokenId] });
    return Promise.resolve({ token_id: tokenId, revoked: true });
  }),
  getBlob: vi.fn((attachmentId: unknown) => {
    calls.push({ method: "getBlob", args: [attachmentId] });
    return Promise.resolve({ attachment_id: attachmentId, scope: "agent" });
  }),
  deleteBlob: vi.fn((attachmentId: unknown) => {
    calls.push({ method: "deleteBlob", args: [attachmentId] });
    return Promise.resolve({ deleted: true });
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runBlob } from "./attachment.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes"]);

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
    await runBlob(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runBlob dispatch", () => {
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
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("invalid_args");
    expect(err.message).toContain("unknown attachment verb");
  });

  it("forwards `show <id>` to runBlobShow (positionals[0] = id after slice)", async () => {
    await run(["show", "attachment_abc"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([{ method: "getBlob", args: ["attachment_abc"] }]);
  });

  it("forwards `delete <id>` to runBlobDelete", async () => {
    await run(["delete", "attachment_xyz"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([{ method: "deleteBlob", args: ["attachment_xyz"] }]);
  });

  it("propagates missing-id errors from the verb runner", async () => {
    await run(["show"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <attachment-id>");
  });
});

describe("runBlob list", () => {
  it("forwards `list` with no opts by default", async () => {
    await run(["list"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      { method: "listBlobs", args: [{ cursor: undefined, limit: undefined }] },
    ]);
  });

  it("forwards --cursor + --limit to client.listBlobs", async () => {
    await run(["list", "--cursor", "opaque", "--limit", "25"]);
    expect(exitCode).toBeUndefined();
    expect(calls[0]!.args[0]).toEqual({ cursor: "opaque", limit: 25 });
  });

  it("rejects --limit out of 1..100 before the network call", async () => {
    await run(["list", "--limit", "0"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);

    stderr = "";
    exitCode = undefined;
    await run(["list", "--limit", "101"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("runBlob token", () => {
  it("mints a token: `token mint <id>`", async () => {
    await run(["token", "mint", "attachment_abc"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      {
        method: "mintBlobToken",
        args: ["attachment_abc", { ttlSeconds: undefined, once: false }],
      },
    ]);
  });

  it("mints with --ttl + --once", async () => {
    await run(["token", "mint", "attachment_abc", "--ttl", "3600", "--once"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      {
        method: "mintBlobToken",
        args: ["attachment_abc", { ttlSeconds: 3600, once: true }],
      },
    ]);
  });

  it("revokes: `token revoke <id> <token-id>`", async () => {
    await run(["token", "revoke", "attachment_abc", "tk_x"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      { method: "revokeBlobToken", args: ["attachment_abc", "tk_x"] },
    ]);
  });

  it("lists tokens for one attachment: `token list <id>`", async () => {
    await run(["token", "list", "attachment_abc"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      { method: "listBlobTokens", args: ["attachment_abc"] },
    ]);
  });

  it("rejects an unknown token verb", async () => {
    await run(["token", "frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown token verb");
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing token verb", async () => {
    await run(["token"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing verb");
    expect(calls).toHaveLength(0);
  });

  it("fails with a clear error when 'mint' is missing <attachment-id>", async () => {
    await run(["token", "mint"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <attachment-id>");
    expect(calls).toHaveLength(0);
  });

  it("fails when 'revoke' is missing <token-id>", async () => {
    await run(["token", "revoke", "attachment_abc"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing arguments");
    expect(calls).toHaveLength(0);
  });

  it("fails when 'list' is missing <attachment-id>", async () => {
    await run(["token", "list"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <attachment-id>");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-integer --ttl", async () => {
    await run(["token", "mint", "attachment_abc", "--ttl", "abc"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--ttl must be a positive integer");
    expect(calls).toHaveLength(0);
  });

  it("rejects a zero / negative --ttl", async () => {
    await run(["token", "mint", "attachment_abc", "--ttl", "0"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
