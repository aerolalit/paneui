// In-memory revocation cache for blob tokens.
//
// Capability-URL leakage is a known failure mode (proposal #152 + #155). When
// an agent revokes a token, the relay needs the revocation to take effect
// fast — every additional second a leaked token stays usable is an extra
// chance for it to be exploited. The DB row is the source of truth, but
// hitting Postgres on every `/b/<token>` request and reading `revoked_at`
// would add a hop in the hot path.
//
// This cache is a Set<token_hash> populated when:
//   * a DELETE /v1/blobs/:id/tokens/:token_id request lands
//   * a /b/<token> request loads a row whose revokedAt is already set
//
// The route consults the cache first; a hit short-circuits to 401. A miss
// proceeds to the DB, where revoked_at is still checked — the cache is a
// fast-path optimisation, not the security boundary. In a multi-replica
// deployment (Redis-backed), this falls back to in-process per replica;
// the DB check is what keeps cross-replica correctness honest.
//
// Memory pressure is bounded by `MAX_ENTRIES`: the oldest entries get
// evicted FIFO. A revoked token's DB row still says `revoked_at != null`,
// so eviction from the cache doesn't unrevoke it — at worst, a request
// after eviction pays a DB round trip and still returns 401.

const DEFAULT_MAX_ENTRIES = 10_000;

export interface RevokeCache {
  /** Mark a token hash as revoked. Cheap; idempotent. */
  add(hash: string): void;
  /** True iff the hash is known to be revoked in this process. */
  has(hash: string): boolean;
  /** For tests. */
  size(): number;
  /** For tests. */
  clear(): void;
}

export function makeRevokeCache(
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): RevokeCache {
  // FIFO. A Set iterates in insertion order, so deleting the first key when
  // we're over the cap evicts the oldest.
  const set = new Set<string>();

  return {
    add(hash) {
      if (set.has(hash)) return;
      set.add(hash);
      if (set.size > maxEntries) {
        const first = set.values().next().value;
        if (first !== undefined) set.delete(first);
      }
    },
    has(hash) {
      return set.has(hash);
    },
    size() {
      return set.size;
    },
    clear() {
      set.clear();
    },
  };
}
