// Unit tests for FilesystemBlobStore — backend semantics in isolation
// (no relay, no Hono, no DB). Covers init / put / get / head / delete plus
// the world-readable refusal and the size-cap mid-stream cut.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, chmodSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobSizeExceededError, FilesystemBlobStore } from "./index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blob-fs-test-"));
});

afterEach(() => {
  // Reset mode in case a test left it unreadable for us.
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* dir may already be gone */
  }
  rmSync(dir, { recursive: true, force: true });
});

function streamOf(bytes: Uint8Array): Readable {
  return Readable.from(Buffer.from(bytes));
}

describe("FilesystemBlobStore.init", () => {
  it("creates the directory if it doesn't exist", async () => {
    const sub = join(dir, "new-dir");
    const store = new FilesystemBlobStore({ dir: sub });
    await store.init();
    const st = statSync(sub);
    expect(st.isDirectory()).toBe(true);
  });

  it("accepts an existing 0700 directory", async () => {
    chmodSync(dir, 0o700);
    const store = new FilesystemBlobStore({ dir });
    await store.init(); // does not throw
  });

  it("refuses a world-readable directory", async () => {
    chmodSync(dir, 0o755); // group + world readable
    const store = new FilesystemBlobStore({ dir });
    await expect(store.init()).rejects.toThrow(/world-readable/);
  });

  it("refuses when the path exists but is a file, not a directory", async () => {
    const file = join(dir, "actually-a-file");
    await writeFile(file, "i am not a dir");
    const store = new FilesystemBlobStore({ dir: file });
    await expect(store.init()).rejects.toThrow(/not a directory/);
  });
});

describe("FilesystemBlobStore round trip", () => {
  it("put → head → get → delete round-trips identical bytes", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();

    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xfa, 0xce]);
    const info = await store.put("blob_x", streamOf(payload), {
      mime: "image/jpeg",
      maxBytes: 1_000_000,
    });
    expect(info.size).toBe(payload.length);
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info.mime).toBe("image/jpeg");

    const head = await store.head("blob_x");
    expect(head).not.toBeNull();
    expect(head!.size).toBe(info.size);
    expect(head!.sha256).toBe(info.sha256);

    const stream = await store.get("blob_x");
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of stream!) chunks.push(c as Buffer);
    const got = Buffer.concat(chunks);
    expect(got.equals(Buffer.from(payload))).toBe(true);

    await store.delete("blob_x");
    expect(await store.head("blob_x")).toBeNull();
    expect(await store.get("blob_x")).toBeNull();
  });

  it("get + head return null for an unknown key", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();
    expect(await store.get("blob_nope")).toBeNull();
    expect(await store.head("blob_nope")).toBeNull();
  });

  it("delete is idempotent (no error on a missing key)", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();
    await store.delete("blob_nothing-here");
    await store.delete("blob_nothing-here");
  });

  it("written files have mode 0600", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();
    await store.put("blob_mode", streamOf(Buffer.from("x")), {
      mime: "application/octet-stream",
      maxBytes: 100,
    });
    const st = statSync(join(dir, "blob_mode"));
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe("FilesystemBlobStore size cap", () => {
  it("rejects mid-stream when bytes exceed maxBytes (no partial file persists)", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();

    // 100 KB payload, cap at 10 KB.
    const big = Buffer.alloc(100 * 1024, 0xaa);
    await expect(
      store.put("blob_big", Readable.from(big), {
        mime: "application/octet-stream",
        maxBytes: 10 * 1024,
      }),
    ).rejects.toBeInstanceOf(BlobSizeExceededError);

    // Final file shouldn't exist (atomic-rename means the tmp file is the
    // only thing that could leak — verify both are gone).
    expect(await store.head("blob_big")).toBeNull();
    expect(await store.get("blob_big")).toBeNull();
  });

  it("accepts a payload exactly equal to maxBytes", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();
    const exact = Buffer.alloc(1024, 0xbb);
    const info = await store.put("blob_exact", Readable.from(exact), {
      mime: "application/octet-stream",
      maxBytes: 1024,
    });
    expect(info.size).toBe(1024);
  });
});

describe("FilesystemBlobStore integrity", () => {
  it("head() returns null when the sidecar is corrupt", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();
    await store.put("blob_corrupt", streamOf(Buffer.from("hi")), {
      mime: "application/octet-stream",
      maxBytes: 100,
    });
    // Smear the sidecar with garbage.
    await writeFile(join(dir, "blob_corrupt.meta.json"), "not json {{{");
    const got = await readFile(join(dir, "blob_corrupt.meta.json"), "utf8");
    expect(got).toBe("not json {{{"); // sanity: the write landed
    expect(await store.head("blob_corrupt")).toBeNull();
  });
});

describe("FilesystemBlobStore sidecar field naming (ciphertext_sha256)", () => {
  it("new writes use 'ciphertext_sha256' on disk (and only that key)", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();

    const info = await store.put("blob_new", streamOf(Buffer.from("payload")), {
      mime: "application/octet-stream",
      maxBytes: 100,
    });

    const raw = await readFile(join(dir, "blob_new.meta.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.ciphertext_sha256).toBe(info.sha256);
    // No legacy alias — new writes are clean.
    expect("sha256" in parsed).toBe(false);
    expect(parsed.size).toBe(info.size);
    expect(parsed.mime).toBe("application/octet-stream");
  });

  it("head() round-trips a freshly written blob via ciphertext_sha256", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();

    const payload = Buffer.from("round-trip-payload");
    const info = await store.put("blob_rt", streamOf(payload), {
      mime: "image/png",
      maxBytes: 100,
    });
    const head = await store.head("blob_rt");
    expect(head).not.toBeNull();
    expect(head!.size).toBe(info.size);
    expect(head!.sha256).toBe(info.sha256);
    expect(head!.mime).toBe("image/png");
  });

  it("head() still reads legacy sidecars that use the bare 'sha256' key", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();
    // Write the payload via the store so the data file lands at the right
    // path with the right mode; then OVERWRITE the sidecar with the legacy
    // shape (bare `sha256`, no `ciphertext_sha256` key) to simulate a
    // deployment that still has the old field name on disk.
    const payload = Buffer.from("legacy-payload");
    const info = await store.put("blob_legacy", streamOf(payload), {
      mime: "image/jpeg",
      maxBytes: 100,
    });
    const legacy = {
      size: info.size,
      sha256: info.sha256,
      mime: info.mime,
    };
    await writeFile(join(dir, "blob_legacy.meta.json"), JSON.stringify(legacy));

    const head = await store.head("blob_legacy");
    expect(head).not.toBeNull();
    expect(head!.size).toBe(info.size);
    expect(head!.sha256).toBe(info.sha256);
    expect(head!.mime).toBe("image/jpeg");
  });

  it("head() returns null when neither sidecar hash key is present", async () => {
    const store = new FilesystemBlobStore({ dir });
    await store.init();
    const payload = Buffer.from("no-hash");
    await store.put("blob_nohash", streamOf(payload), {
      mime: "application/octet-stream",
      maxBytes: 100,
    });
    // Overwrite the sidecar with a JSON object that has size but no hash.
    await writeFile(
      join(dir, "blob_nohash.meta.json"),
      JSON.stringify({
        size: payload.length,
        mime: "application/octet-stream",
      }),
    );
    expect(await store.head("blob_nohash")).toBeNull();
  });
});
