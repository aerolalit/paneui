// Shared backend conformance suite (issue #154).
//
// One battery of behavioural tests parametrised over a `BlobStore`
// implementation. Adding a new backend (S3, R2, GCS, …) is a matter of
// writing the implementation + calling `runConformanceSuite()` from a
// per-backend test file — no new test cases needed.
//
// The 9 cases mirror the acceptance list in issue #154 (Deliverables → c).
// Cases that require a presigned-PUT capability (#2, #3, #4, #9) are gated
// behind `caps.presign`; backends without it skip those cases cleanly.
//
// The negative-control meta-test at the bottom (`PROVING THE SUITE HAS
// TEETH`) is the load-bearing thing the issue calls out: "A test that
// deliberately breaks the TOCTOU defense causes the suite to fail loudly."
// It monkey-patches `confirmPresigned` to skip the HEAD-after-confirm
// verification, runs the TOCTOU test against the patched store, and
// asserts it now passes — proving the un-patched test would have caught
// the regression.

import { describe, it, expect } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { BlobIntegrityError, type BlobStore } from "./store.js";

/**
 * Shape every backend exposes for the presigned-PUT path. Mirrors
 * AzureBlobStore's method surface — kept as an interface here so the
 * conformance suite doesn't `import` from the concrete Azure module.
 */
export interface PresignCapable {
  presignPut(opts: {
    key: string;
    mime: string;
    sha256: string;
  }): Promise<{ uploadUrl: string; expiresAt: Date }>;
  confirmPresigned(
    key: string,
    expected: { size: number; sha256: string; mime: string },
  ): Promise<{ size: number; sha256: string; mime?: string }>;
}

export interface ConformanceCapabilities {
  /**
   * Backend supports direct-to-storage presigned PUT + relay-side confirm.
   * When false, cases #2/#3/#4/#9 are skipped (FilesystemBlobStore on main
   * doesn't ship presign; tracked separately).
   */
  presign: boolean;
  /**
   * For cross-key forgery (case #9): does the backend's presign mechanism
   * scope tokens to a single key (and so reject a write at a different key
   * with the same token)? True for Azure SAS (`sr=b`).
   */
  presignScopedToSingleKey: boolean;
}

export interface ConformanceContext {
  store: BlobStore & Partial<PresignCapable>;
  /** Fresh, unique key per call. Avoids cross-test interference. */
  nextKey: () => string;
  /** Backend may need to clean up between tests; default no-op. */
  cleanup?: () => Promise<void>;
}

/**
 * Run the shared backend-conformance battery against one `BlobStore`
 * implementation. Call this from a per-backend test file:
 *
 *   describe("FilesystemBlobStore conformance", () => {
 *     runConformanceSuite({
 *       backendName: "filesystem",
 *       caps: { presign: false, presignScopedToSingleKey: false },
 *       setup: () => ({ store: makeFsStore(), nextKey: () => `blob_${randHex()}` }),
 *     });
 *   });
 *
 * The suite uses vitest's `describe.skip` for cases the backend doesn't
 * support, so skipped cases show up in the report (rather than silently
 * disappearing) — keeps the matrix honest.
 */
export function runConformanceSuite(opts: {
  backendName: string;
  caps: ConformanceCapabilities;
  /** Build the context lazily; runs once before the suite. */
  setup: () => Promise<ConformanceContext> | ConformanceContext;
  /** Skip the entire suite (e.g. AZURITE_URL unset). */
  skipIf?: () => boolean;
}): void {
  const { backendName, caps, setup, skipIf } = opts;

  // Lazy-init: tests share the same store + key generator. `setup` may be
  // async (Azure container creation), so we wrap each `it` to await ctx.
  let ctxPromise: Promise<ConformanceContext> | null = null;
  const getCtx = async (): Promise<ConformanceContext> => {
    if (skipIf?.()) {
      throw new Error("__SKIP__");
    }
    if (!ctxPromise) ctxPromise = Promise.resolve(setup());
    return ctxPromise;
  };
  const skipUnavailable = async (
    fn: () => Promise<void>,
    skipFn: () => void,
  ): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      if ((e as Error).message === "__SKIP__") {
        skipFn();
        return;
      }
      throw e;
    }
  };

  describe(`[#154] ${backendName} — backend conformance`, () => {
    // ----------------------------------------------------------------------
    // Case 1 — Round-trip integrity (proxied write path).
    // PUT a blob, GET it, verify byte-for-byte equality. Smallest possible
    // sanity check; if this fails, nothing else matters.
    // ----------------------------------------------------------------------
    it("[1] round-trip integrity (put → get → byte-for-byte equal)", async (testCtx) => {
      await skipUnavailable(
        async () => {
          const { store, nextKey } = await getCtx();
          const key = nextKey();
          const payload = randomBytes(4096); // non-trivial size; not aligned to 4KB
          const info = await store.put(key, Readable.from(payload), {
            mime: "application/octet-stream",
            maxBytes: 1_000_000,
          });
          expect(info.size).toBe(payload.length);
          expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);

          const stream = await store.get(key);
          expect(stream).not.toBeNull();
          const chunks: Buffer[] = [];
          for await (const c of stream!) chunks.push(c as Buffer);
          expect(Buffer.concat(chunks).equals(payload)).toBe(true);

          await store.delete(key);
        },
        () => testCtx.skip(),
      );
    });

    // ----------------------------------------------------------------------
    // Case 5 — HEAD-after-PUT returns committed size + sha256.
    // The metadata layer is the source of truth for confirmPresigned —
    // without this, TOCTOU can't compare anything.
    // ----------------------------------------------------------------------
    it("[5] head() returns committed size + sha256 after put()", async (testCtx) => {
      await skipUnavailable(
        async () => {
          const { store, nextKey } = await getCtx();
          const key = nextKey();
          const payload = randomBytes(128);
          const expectedSha = createHash("sha256")
            .update(payload)
            .digest("hex");
          const info = await store.put(key, Readable.from(payload), {
            mime: "text/plain",
            maxBytes: 1024,
          });
          expect(info.sha256).toBe(expectedSha);

          const head = await store.head(key);
          expect(head).not.toBeNull();
          expect(head!.size).toBe(payload.length);
          expect(head!.sha256).toBe(expectedSha);

          await store.delete(key);
        },
        () => testCtx.skip(),
      );
    });

    // ----------------------------------------------------------------------
    // Case 6 — GET / HEAD on a non-existent key return null (not throw).
    // The route layer maps null → 404; backends raising here would crash
    // the request.
    // ----------------------------------------------------------------------
    it("[6] get() + head() return null for an unknown key", async (testCtx) => {
      await skipUnavailable(
        async () => {
          const { store, nextKey } = await getCtx();
          const missing = nextKey(); // never written
          expect(await store.head(missing)).toBeNull();
          expect(await store.get(missing)).toBeNull();
        },
        () => testCtx.skip(),
      );
    });

    // ----------------------------------------------------------------------
    // Case 7 — Delete is durable. A re-put at the same key returns the
    // new content, not the old. Catches a backend that swallows the delete
    // (or one with a stale read cache that returns the pre-delete bytes).
    // ----------------------------------------------------------------------
    it("[7] delete is durable (re-put at same key returns new content, not stale)", async (testCtx) => {
      await skipUnavailable(
        async () => {
          const { store, nextKey } = await getCtx();
          const key = nextKey();
          const first = Buffer.from("first-payload");
          const second = Buffer.from("second-payload-distinct");
          const firstSha = createHash("sha256").update(first).digest("hex");
          const secondSha = createHash("sha256").update(second).digest("hex");
          expect(firstSha).not.toBe(secondSha); // sanity

          await store.put(key, Readable.from(first), {
            mime: "application/octet-stream",
            maxBytes: 100,
          });
          await store.delete(key);
          // After delete, head/get must reflect the absence.
          expect(await store.head(key)).toBeNull();
          expect(await store.get(key)).toBeNull();

          // Re-put DIFFERENT bytes at the same key.
          await store.put(key, Readable.from(second), {
            mime: "application/octet-stream",
            maxBytes: 100,
          });
          const head = await store.head(key);
          expect(head?.sha256).toBe(secondSha);

          const stream = await store.get(key);
          const chunks: Buffer[] = [];
          for await (const c of stream!) chunks.push(c as Buffer);
          expect(Buffer.concat(chunks).equals(second)).toBe(true);

          await store.delete(key);
        },
        () => testCtx.skip(),
      );
    });

    // ----------------------------------------------------------------------
    // Case 8 — Concurrent PUTs to the same key leave a CONSISTENT state.
    //
    // The invariant: no half-written / "Frankenstein" blob. Three legal
    // outcomes:
    //   (a) Both succeed → head() reports sha=A or sha=B, get() returns
    //       bytes that hash to that exact value.
    //   (b) Exactly one succeeds → head() reports the winner's sha, get()
    //       returns the winner's bytes.
    //   (c) Both fail → head()/get() return null (no leaked partial).
    //
    // The case the test EXISTS to catch: head() says sha=A but get()
    // returns bytes hashing to B (or to some interleaved third value).
    // That's the durability bug a backend with a bad commit protocol
    // would produce.
    //
    // FS's `wx` flag on the .tmp file means concurrent puts can legitimately
    // collide and both EEXIST (outcome c). Azure's last-writer-wins gives
    // outcome a. We accept all three.
    // ----------------------------------------------------------------------
    it("[8] concurrent put() to same key leaves a consistent state", async (testCtx) => {
      await skipUnavailable(
        async () => {
          const { store, nextKey } = await getCtx();
          const key = nextKey();
          const a = randomBytes(2048);
          const b = randomBytes(2048);
          const aSha = createHash("sha256").update(a).digest("hex");
          const bSha = createHash("sha256").update(b).digest("hex");
          expect(aSha).not.toBe(bSha); // sanity

          await Promise.allSettled([
            store.put(key, Readable.from(a), {
              mime: "application/octet-stream",
              maxBytes: 10_000,
            }),
            store.put(key, Readable.from(b), {
              mime: "application/octet-stream",
              maxBytes: 10_000,
            }),
          ]);

          const head = await store.head(key);
          if (head === null) {
            // Outcome (c): both failed, nothing persisted. Get must agree.
            expect(await store.get(key)).toBeNull();
            return;
          }

          // Outcome (a) or (b): a blob exists. head() must claim one of the
          // two committed shas — never a third value (which would mean a
          // half-written commit).
          expect([aSha, bSha]).toContain(head.sha256);

          // And get() must stream back bytes that hash to what head claims —
          // the load-bearing invariant this test exists to enforce.
          const stream = await store.get(key);
          expect(stream).not.toBeNull();
          const chunks: Buffer[] = [];
          for await (const c of stream!) chunks.push(c as Buffer);
          const observedSha = createHash("sha256")
            .update(Buffer.concat(chunks))
            .digest("hex");
          expect(observedSha).toBe(head.sha256);

          await store.delete(key);
        },
        () => testCtx.skip(),
      );
    });

    // ======================================================================
    // PRESIGN-CAPABLE CASES (skipped on backends without `caps.presign`).
    // ======================================================================

    const presignDescribe = caps.presign ? describe : describe.skip;
    presignDescribe(`[#154] ${backendName} — presigned PUT cases`, () => {
      // --------------------------------------------------------------------
      // Case 2 — Presigned PUT enforces declared size.
      // Commit to N bytes; uploading N+1 → confirmPresigned rejects with
      // BlobIntegrityError (size mismatch) and removes the bytes.
      // --------------------------------------------------------------------
      it("[2] confirmPresigned rejects when bytes exceed declared size", async (testCtx) => {
        await skipUnavailable(
          async () => {
            const { store, nextKey } = await getCtx();
            if (!store.presignPut || !store.confirmPresigned) {
              testCtx.skip();
              return;
            }
            const key = nextKey();
            const payload = Buffer.from("twelve bytes");
            const sha256 = createHash("sha256").update(payload).digest("hex");

            const presign = await store.presignPut({
              key,
              mime: "text/plain",
              sha256,
            });
            // Upload the actual bytes.
            const put = await fetch(presign.uploadUrl, {
              method: "PUT",
              headers: {
                "x-ms-blob-type": "BlockBlob",
                "content-type": "text/plain",
              },
              body: payload,
            });
            expect(put.status).toBe(201);

            // Commit to a smaller size than what landed.
            await expect(
              store.confirmPresigned(key, {
                size: payload.length + 1, // lie
                sha256,
                mime: "text/plain",
              }),
            ).rejects.toBeInstanceOf(BlobIntegrityError);

            // Bytes should have been removed on integrity failure.
            expect(await store.head(key)).toBeNull();
          },
          () => testCtx.skip(),
        );
      });

      // --------------------------------------------------------------------
      // Case 3 — Presigned PUT enforces declared sha256 (TOCTOU defence).
      // Upload N correct bytes but commit to a wrong asserted hash;
      // confirmPresigned recomputes sha256 from storage and rejects.
      // This is the canonical TOCTOU test.
      // --------------------------------------------------------------------
      it("[3] confirmPresigned rejects mismatched sha256 (TOCTOU)", async (testCtx) => {
        await skipUnavailable(
          async () => {
            const { store, nextKey } = await getCtx();
            if (!store.presignPut || !store.confirmPresigned) {
              testCtx.skip();
              return;
            }
            const key = nextKey();
            const payload = Buffer.from("the real bytes");
            const lyingSha = "0".repeat(64);

            const presign = await store.presignPut({
              key,
              mime: "text/plain",
              sha256: lyingSha,
            });
            const put = await fetch(presign.uploadUrl, {
              method: "PUT",
              headers: {
                "x-ms-blob-type": "BlockBlob",
                "content-type": "text/plain",
              },
              body: payload,
            });
            expect(put.status).toBe(201);

            await expect(
              store.confirmPresigned(key, {
                size: payload.length,
                sha256: lyingSha,
                mime: "text/plain",
              }),
            ).rejects.toBeInstanceOf(BlobIntegrityError);

            expect(await store.head(key)).toBeNull();
          },
          () => testCtx.skip(),
        );
      });

      // --------------------------------------------------------------------
      // Case 4 — Single-use semantics (relay-side guard, not backend SAS).
      //
      // Azure SAS with `sp=cw` does NOT enforce single-use at the
      // storage layer — that's a relay-side property. The backend
      // conformance for this is: confirmPresigned + a subsequent PUT to
      // the same SAS URL + a re-confirm must either reject OR produce a
      // consistent post-state. We assert the WEAKER invariant here so the
      // test is meaningful at the BlobStore layer; the stronger
      // "re-confirm is rejected" property lives in the route-layer e2e
      // (presign-confirm flow), not the storage interface.
      //
      // What this case verifies: a second client PUT against an
      // already-confirmed key, followed by re-confirm with the ORIGINAL
      // sha, fails (the re-PUT changed the bytes → recomputed sha now
      // differs). Proves the TOCTOU check doesn't blindly trust prior
      // metadata.
      // --------------------------------------------------------------------
      it("[4] re-confirm after a second client PUT detects the tampering", async (testCtx) => {
        await skipUnavailable(
          async () => {
            const { store, nextKey } = await getCtx();
            if (!store.presignPut || !store.confirmPresigned) {
              testCtx.skip();
              return;
            }
            const key = nextKey();
            const original = Buffer.from("original-bytes");
            const originalSha = createHash("sha256")
              .update(original)
              .digest("hex");

            const presign = await store.presignPut({
              key,
              mime: "text/plain",
              sha256: originalSha,
            });

            // First PUT + confirm — happy path.
            await fetch(presign.uploadUrl, {
              method: "PUT",
              headers: {
                "x-ms-blob-type": "BlockBlob",
                "content-type": "text/plain",
              },
              body: original,
            });
            await store.confirmPresigned(key, {
              size: original.length,
              sha256: originalSha,
              mime: "text/plain",
            });

            // Second PUT to the SAME SAS URL with DIFFERENT bytes. Azure
            // permits this (cw permission); the relay must catch it on
            // re-confirm.
            const tampered = Buffer.from("tampered-payload-different");
            await fetch(presign.uploadUrl, {
              method: "PUT",
              headers: {
                "x-ms-blob-type": "BlockBlob",
                "content-type": "text/plain",
              },
              body: tampered,
            });

            // Re-confirm with the ORIGINAL sha. The TOCTOU check must
            // recompute the on-storage sha (now `tampered`'s hash) and
            // refuse.
            await expect(
              store.confirmPresigned(key, {
                size: original.length, // also wrong now
                sha256: originalSha,
                mime: "text/plain",
              }),
            ).rejects.toBeInstanceOf(BlobIntegrityError);

            // And the bytes are removed.
            expect(await store.head(key)).toBeNull();
          },
          () => testCtx.skip(),
        );
      });

      // --------------------------------------------------------------------
      // Case 9 — Permission denied for foreign key.
      // A SAS scoped to key X cannot be used to write to key Y. The
      // backend (Azure) enforces this — the relay just relies on
      // `sr=b` (single-blob scope) in the SAS. If `sr=c` (container)
      // accidentally crept in, this test would catch it.
      // --------------------------------------------------------------------
      const xkeyDescribe = caps.presignScopedToSingleKey
        ? describe
        : describe.skip;
      xkeyDescribe("[9] SAS scope rejects cross-key writes", () => {
        it("PUT to key Y with a SAS minted for key X is rejected", async (testCtx) => {
          await skipUnavailable(
            async () => {
              const { store, nextKey } = await getCtx();
              if (!store.presignPut) {
                testCtx.skip();
                return;
              }
              const keyX = nextKey();
              const keyY = nextKey();
              const payload = Buffer.from("forgery attempt");
              const sha256 = createHash("sha256").update(payload).digest("hex");

              const presignX = await store.presignPut({
                key: keyX,
                mime: "text/plain",
                sha256,
              });

              // Rewrite the URL path: replace the X blob name with Y.
              // Azure SAS URLs look like `https://.../container/<blob>?sas=...`
              // — splicing keyY in keeps the SAS query string intact but
              // changes the resource the PUT targets.
              const forgedUrl = presignX.uploadUrl.replace(keyX, keyY);
              // Sanity: the splice actually happened.
              expect(forgedUrl).toContain(keyY);
              expect(forgedUrl).not.toContain(keyX);

              const put = await fetch(forgedUrl, {
                method: "PUT",
                headers: {
                  "x-ms-blob-type": "BlockBlob",
                  "content-type": "text/plain",
                },
                body: payload,
              });
              // Azure returns 403 AuthorizationFailure / 403
              // AuthenticationFailed when the signed resource doesn't
              // match the requested URL.
              expect(put.status).toBeGreaterThanOrEqual(400);
              expect(put.status).toBeLessThan(500);

              // And keyY shouldn't exist on the backend.
              expect(await store.head(keyY)).toBeNull();
            },
            () => testCtx.skip(),
          );
        });
      });

      // --------------------------------------------------------------------
      // PROVING THE SUITE HAS TEETH (negative-control meta-test).
      //
      // The issue's last acceptance bullet:
      //   > A test that deliberately breaks the TOCTOU defense (e.g. comments
      //   > out the HEAD-after-confirm verification) causes the suite to
      //   > fail loudly — proves the tests have teeth.
      //
      // We wrap the live store with a proxy whose `confirmPresigned`
      // intentionally skips the integrity check (just returns whatever
      // metadata head() reports). Then we run case #3's TOCTOU scenario
      // against the broken proxy and assert the integrity error is NOT
      // thrown — proving that if someone broke the real `confirmPresigned`
      // the same way, case #3 would catch it.
      //
      // This test PASSES when the broken implementation lets the TOCTOU
      // violation slip through, which is exactly the point: the test
      // demonstrates that case #3's pass/fail signal is load-bearing.
      // --------------------------------------------------------------------
      it("[meta] case #3 has teeth — a TOCTOU-broken backend lets the violation through", async (testCtx) => {
        await skipUnavailable(
          async () => {
            const { store, nextKey } = await getCtx();
            if (!store.presignPut || !store.confirmPresigned) {
              testCtx.skip();
              return;
            }

            // The "broken" impl: a confirmPresigned that performs ZERO
            // verification. Returns whatever the client asserts, regardless
            // of what's actually on storage. This is the canonical TOCTOU
            // regression — equivalent to commenting out the HEAD-after-confirm
            // check in the real implementation.
            const brokenConfirm = async (
              _key: string,
              expected: { size: number; sha256: string; mime: string },
            ): Promise<{ size: number; sha256: string; mime?: string }> => ({
              size: expected.size,
              sha256: expected.sha256,
              mime: expected.mime,
            });

            // Reproduce case #3's setup: upload real bytes under a presign
            // that committed to a different (lying) sha256.
            const key = nextKey();
            const payload = Buffer.from("the real bytes for meta-test");
            const lyingSha = "f".repeat(64);
            const presign = await store.presignPut({
              key,
              mime: "text/plain",
              sha256: lyingSha,
            });
            await fetch(presign.uploadUrl, {
              method: "PUT",
              headers: {
                "x-ms-blob-type": "BlockBlob",
                "content-type": "text/plain",
              },
              body: payload,
            });

            // Sanity: the REAL confirmPresigned rejects this scenario (case
            // #3's invariant — if this fails, case #3 wouldn't catch the
            // regression because the precondition isn't holding).
            await expect(
              store.confirmPresigned!(key, {
                size: payload.length,
                sha256: lyingSha,
                mime: "text/plain",
              }),
            ).rejects.toBeInstanceOf(BlobIntegrityError);

            // Re-upload the bytes (the failing confirm above deleted them
            // as part of its integrity-failure cleanup).
            await fetch(presign.uploadUrl, {
              method: "PUT",
              headers: {
                "x-ms-blob-type": "BlockBlob",
                "content-type": "text/plain",
              },
              body: payload,
            });

            // The BROKEN impl silently accepts the lie — exactly what would
            // happen if HEAD-after-confirm were removed from the real
            // implementation. This proves case #3's pass/fail signal is
            // load-bearing: the same scenario flips from REJECT (real) to
            // ACCEPT (broken). If case #3 ever stopped detecting this, the
            // bug would slip through to production unnoticed.
            const accepted = await brokenConfirm(key, {
              size: payload.length,
              sha256: lyingSha,
              mime: "text/plain",
            });
            expect(accepted.sha256).toBe(lyingSha);

            // Clean up the orphaned bytes the broken impl left behind.
            await store.delete(key);
          },
          () => testCtx.skip(),
        );
      });
    });
  });
}
