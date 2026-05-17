-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('open', 'closed');

-- DropIndex
-- Drop the redundant non-unique index on agents.key_hash. The column already
-- has a UNIQUE index (agents_key_hash_key from @unique), which serves every
-- lookup the plain index would; keeping both just doubled write overhead.
DROP INDEX "agents_key_hash_idx";

-- AlterTable
-- Convert sessions.status from TEXT to the SessionStatus enum in place. The
-- USING cast preserves existing rows ('open'/'closed') instead of dropping
-- and recreating the column.
ALTER TABLE "sessions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "sessions" ALTER COLUMN "status" TYPE "SessionStatus" USING ("status"::"SessionStatus");
ALTER TABLE "sessions" ALTER COLUMN "status" SET DEFAULT 'open';
