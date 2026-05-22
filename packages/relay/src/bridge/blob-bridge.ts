// /b/<token> — capability-URL fetch path for blob bytes.
//
// This is the participant-facing download path. The URL token IS the
// credential — no agent key, no participant token. That makes the token a
// bearer secret in URL form (see proposal #152 and #155 for the threat
// model and the layered defences):
//
//   * 192-bit token entropy (24 random bytes, base64url-encoded)
//   * Scope-bound TTL set at mint time
//   * Revocable via DELETE /v1/blobs/:id/tokens/:token_id (instant,
//     short-circuited by an in-process cache)
//   * `once = true` tokens self-delete on first successful GET
//   * Hardened response headers (nosniff, attachment for non-image,
//     same-origin CORP, no-referrer)
//   * Access logs redact the token (the request middleware in app.ts
//     replaces `/b/<token>` with `/b/***` in logged paths)
//   * Per-token audit columns updated on each hit, with /24-truncated
//     IPv4 (or /48-truncated IPv6) ranges — full requester IPs are
//     never persisted

import { Hono } from "hono";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import { errors } from "../http/errors.js";
import type { AppEnv } from "../http/env.js";
import {
  hashBlobToken,
  looksLikeBlobToken,
  truncateIp,
} from "../blobs/index.js";

const blobBridge = new Hono<AppEnv>();

// GET /b/:token — fetch a blob via its capability URL.
//
// Validation flow:
//   1. Token shape — fail fast before any DB read on obvious garbage.
//   2. In-process revoke cache — short-circuit known-revoked tokens.
//   3. DB lookup by hash.
//   4. Expiry / revoke / status checks. All four "this token won't work"
//      cases collapse to one error (blob_token_invalid) so an attacker
//      probing tokens can't distinguish "expired" from "never existed".
//   5. Decrypt the on-disk bytes when the row carries an encryption
//      envelope (BLOB_ENCRYPT_AT_REST=true at upload time). Mirrors the
//      logic in GET /v1/blobs/:id so both download paths return identical
//      plaintext.
//   6. Stream the bytes with hardened headers.
//   7. Audit metadata write (use_count + last_used_at + truncated IPs).
//   8. If once=true, delete the token row (cascade to revoke cache).
blobBridge.get("/:token", async (c) => {
  const prisma = c.get("prisma");
  const store = c.get("blobStore");
  const cache = c.get("blobRevokeCache");

  if (!store) {
    // Misconfiguration — surface a real error rather than a generic 404.
    throw errors.invalidRequest("blob storage is not configured on this relay");
  }

  const token = c.req.param("token");

  // 1. Shape — saves a DB hit on path-spam.
  if (!looksLikeBlobToken(token)) throw errors.blobTokenInvalid();

  // 2. In-process revoke cache.
  const hash = hashBlobToken(token);
  if (cache?.has(hash)) throw errors.blobTokenInvalid();

  // 3. DB lookup.
  const tok = await prisma.blobToken.findUnique({
    where: { tokenHash: hash },
    include: { blob: true },
  });
  if (!tok) throw errors.blobTokenInvalid();

  // 4. State checks.
  if (tok.revokedAt) {
    // Populate the cache for next time.
    cache?.add(hash);
    throw errors.blobTokenInvalid();
  }
  if (tok.expiresAt <= new Date()) {
    cache?.add(hash);
    throw errors.blobTokenInvalid();
  }
  if (!tok.blob || tok.blob.status !== "ready" || tok.blob.deletedAt !== null) {
    throw errors.blobTokenInvalid();
  }

  // 4b. Once-token claim. Atomic + on the request path — not deferred to
  // setImmediate like the rest of the audit work. Two concurrent GETs for
  // the same `once` token both passed the revokedAt check above (a normal
  // browser retry after a dropped TCP connection lands here); only one
  // must be allowed to proceed. `deleteMany(... revokedAt: null)` is a
  // single SQL DELETE with a WHERE clause that the DB serialises — the
  // request that loses the race sees `count === 0` and is turned away
  // before any bytes leave the relay. The hash is added to the in-process
  // revoke cache on BOTH the winner and loser paths so any subsequent
  // in-flight retry short-circuits at step 2 above.
  //
  // Once-tokens deliberately do NOT persist firstSeenIpNet / lastSeenIpNet —
  // the row is gone before the bytes stream and there is nowhere to write
  // them to. This matches the pre-#199 behaviour (the old
  // `writeAuditAndConsume` computed `ipNet` but never used it inside the
  // `if (tok.once)` branch — it deleted the row and returned). The
  // /b/<token> access-log entry (app.ts middleware) carries reqId, method,
  // path (redacted), status, and timing for the request; operators who
  // need the requester IP for forensic purposes should correlate via the
  // upstream proxy / load-balancer logs.
  if (tok.once) {
    const claimed = await prisma.blobToken.deleteMany({
      where: { id: tok.id, revokedAt: null },
    });
    cache?.add(hash);
    if (claimed.count === 0) {
      // Lost the race to a concurrent GET; collapse to the same generic
      // error every other "this token won't work" branch returns so an
      // attacker can't distinguish "raced" from "expired" / "revoked".
      throw errors.blobTokenInvalid();
    }
  }

  const stream = await store.get(tok.blob.storageKey);
  if (!stream) {
    // Bytes are gone — backend rot. Mark the blob failed for next time so
    // subsequent /b/<token> requests fail fast at step 4.
    await prisma.blob
      .update({ where: { id: tok.blob.id }, data: { status: "failed" } })
      .catch(() => {
        /* best-effort */
      });
    throw errors.blobTokenInvalid();
  }

  // 5. Decrypt (when encryption-at-rest is on for this blob). The
  // capability-URL path must mirror GET /v1/blobs/:id's decrypt logic
  // byte-for-byte: the on-disk bytes are ciphertext and the row's
  // `encryptionEnvelope` carries the wrapped DEK + IV + tag. Absent
  // envelope = plaintext bytes in the store (BLOB_ENCRYPT_AT_REST was off
  // when this blob was written). Decryption buffers the full blob to
  // verify the GCM tag — bounded by MAX_BLOB_BYTES so memory cost is
  // known.
  let outputStream: Readable = stream;
  if (tok.blob.encryptionEnvelope) {
    const { decryptBlob, parseEnvelope } = await import("../blobs/encrypt.js");
    const { getMasterKey } = await import("../crypto.js");
    const envelope = parseEnvelope(tok.blob.encryptionEnvelope);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const ciphertext = Buffer.concat(chunks);
    const plaintext = decryptBlob(ciphertext, envelope, getMasterKey());
    outputStream = Readable.from(plaintext);
  }

  // 6. Hardened headers — same set as GET /v1/blobs/:id. Capability-URL
  // surface is the riskier of the two (the URL itself IS the credential)
  // so the defences here are non-negotiable. Content-Length is the
  // PLAINTEXT size (`tok.blob.size`) regardless of encryption.
  c.header("Content-Type", tok.blob.mime);
  c.header("Content-Length", String(tok.blob.size));
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Disposition",
    tok.blob.mime.startsWith("image/") ? "inline" : "attachment",
  );
  c.header("Cache-Control", "private, no-store");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Referrer-Policy", "no-referrer");

  // 7. Audit metadata write. Runs AFTER the body is enqueued so a client
  // cancelling the download still gets credited a use (best-effort
  // semantics). Once-tokens are NOT touched here — they were already
  // claimed atomically at step 4b above, before any bytes left the
  // relay. Errors are swallowed — the human got their bytes.
  if (!tok.once) {
    setImmediate(() => {
      void writeAuditUpdate(prisma, tok, c);
    });
  }

  return c.body(Readable.toWeb(outputStream) as unknown as ReadableStream);
});

/**
 * Fire-and-forget audit metadata update for multi-use tokens.
 *
 * `once`-tokens are handled inline at request time (step 4b in the route)
 * and never reach this function — the deferred path is for the per-hit
 * counters (`useCount`, `lastUsedAt`, IP-net columns) that don't carry
 * security semantics.
 */
async function writeAuditUpdate(
  prisma: PrismaClient,
  tok: {
    id: string;
    firstSeenIpNet: string | null;
  },
  c: { req: { header: (k: string) => string | undefined } },
): Promise<void> {
  const ipNet = truncateIp(
    c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
  );

  await prisma.blobToken
    .update({
      where: { id: tok.id },
      data: {
        useCount: { increment: 1 },
        lastUsedAt: new Date(),
        firstSeenIpNet: tok.firstSeenIpNet ?? ipNet,
        lastSeenIpNet: ipNet,
      },
    })
    .catch(() => {
      /* best-effort */
    });
}

export default blobBridge;
