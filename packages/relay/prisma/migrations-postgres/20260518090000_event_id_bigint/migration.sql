-- Widen events.id from int4 (SERIAL) to int8 (BIGINT) for hosted-scale headroom.
--
-- Why: a SERIAL column is int4 and tops out at 2,147,483,647 rows. At hosted
-- scale a single relay instance could exceed that. BIGINT gives 63-bit range.
--
-- Why the Prisma model stays `Int` (not @db.BigInt): the relay generates ONE
-- @prisma/client shared by the sqlite and postgres schemas. `@db.BigInt` would
-- make the generated `Event.id` a TypeScript `bigint` on postgres and `number`
-- on sqlite — a divergence that forces bigint math at every use site. Keeping
-- the model `Int` keeps the client type `number` on both engines. A JS `number`
-- (float64) represents every integer up to 2^53 (~9e15) exactly, which is far
-- beyond any realistic event count, so reading a BIGINT id into a `number` is
-- safe. Prisma `migrate dev` will report drift against this file; that is
-- expected and intentional — `migrate deploy` (used in CI and prod) applies
-- migration files verbatim and does not diff against the schema.
--
-- Two changes are needed, not one. `ALTER COLUMN ... SET DATA TYPE BIGINT`
-- widens the column, but the owned sequence created by SERIAL is still an
-- `int4` sequence capped at MAXVALUE 2147483647 — so without also widening the
-- sequence, inserts would fail with a sequence-overflow at the exact 2.1B
-- ceiling this migration exists to remove. `ALTER SEQUENCE ... AS bigint`
-- widens the sequence's type and lifts its MAXVALUE to the int8 max.

ALTER TABLE "events" ALTER COLUMN "id" SET DATA TYPE BIGINT;
ALTER SEQUENCE "events_id_seq" AS bigint MAXVALUE 9223372036854775807;
