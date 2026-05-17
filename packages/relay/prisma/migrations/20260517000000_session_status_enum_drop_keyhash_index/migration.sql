-- Drop the redundant non-unique index on agents.key_hash. The column already
-- has a UNIQUE index (agents_key_hash_key from @unique), which serves every
-- lookup the plain index would; keeping both just doubled write overhead.
DROP INDEX "agents_key_hash_idx";

-- sessions.status moves from a free-form String to the SessionStatus enum
-- ('open' | 'closed'). On SQLite, Prisma enums are stored as TEXT, so the
-- column storage is unchanged and no table rewrite is needed.
