// Unit tests for the migration-idempotency helpers in db.ts.
//
// These are the pure functions behind the test harness's `applyMigration`.
// They cover the two routes by which the harness tolerates a re-applied
// migration: the SQL rewriter (`makeStatementIdempotent`) — which transforms
// CREATE TABLE / CREATE INDEX statements to `IF NOT EXISTS` form before they
// hit the database — and the error-pattern matcher
// (`isIdempotentMigrationError`) — the belt-and-suspenders that swallows
// "already exists" failures for the few statement shapes the rewriter
// can't help with (notably SQLite ALTER TABLE ADD COLUMN).
//
// Regression target: issue #118. The matcher previously missed SQLite's
// "there is already another table or index with this name" wording, which
// is what bubbled up when a fresh-DB migration race produced the duplicate
// `artifact_versions` error and broke CI on ~1/3 of runs.

import { describe, it, expect } from "vitest";
import { isIdempotentMigrationError, makeStatementIdempotent } from "./db.js";

describe("isIdempotentMigrationError", () => {
  it("matches SQLite's 'already another table or index' wording (issue #118)", () => {
    const err = new Error(
      "Raw query failed. Code: `1`. Message: `there is already another table or index with this name: artifact_versions`",
    );
    expect(isIdempotentMigrationError(err)).toBe(true);
  });

  it("matches Postgres's 'relation … already exists' wording", () => {
    const err = new Error('relation "artifact_versions" already exists');
    expect(isIdempotentMigrationError(err)).toBe(true);
  });

  it("matches SQLite's 'duplicate column name' wording", () => {
    const err = new Error("SQLITE_ERROR: duplicate column name: status");
    expect(isIdempotentMigrationError(err)).toBe(true);
  });

  it("matches Postgres's 'duplicate key value' wording", () => {
    const err = new Error(
      'duplicate key value violates unique constraint "agents_pkey"',
    );
    expect(isIdempotentMigrationError(err)).toBe(true);
  });

  it("does NOT match unrelated SQL errors", () => {
    expect(isIdempotentMigrationError(new Error("no such table: agents"))).toBe(
      false,
    );
    expect(
      isIdempotentMigrationError(new Error("syntax error near CREATE")),
    ).toBe(false);
    expect(
      isIdempotentMigrationError(new Error("FOREIGN KEY constraint failed")),
    ).toBe(false);
  });

  it("handles non-Error throw values", () => {
    expect(isIdempotentMigrationError("table already exists")).toBe(true);
    expect(isIdempotentMigrationError(null)).toBe(false);
    expect(isIdempotentMigrationError({ code: 1 })).toBe(false);
  });
});

describe("makeStatementIdempotent", () => {
  it("rewrites CREATE TABLE to CREATE TABLE IF NOT EXISTS", () => {
    const out = makeStatementIdempotent(
      'CREATE TABLE "artifact_versions" ("id" TEXT NOT NULL PRIMARY KEY)',
    );
    expect(out).toBe(
      'CREATE TABLE IF NOT EXISTS "artifact_versions" ("id" TEXT NOT NULL PRIMARY KEY)',
    );
  });

  it("rewrites CREATE INDEX to CREATE INDEX IF NOT EXISTS", () => {
    const out = makeStatementIdempotent(
      'CREATE INDEX "artifact_versions_artifact_id_idx" ON "artifact_versions"("artifact_id")',
    );
    expect(out).toBe(
      'CREATE INDEX IF NOT EXISTS "artifact_versions_artifact_id_idx" ON "artifact_versions"("artifact_id")',
    );
  });

  it("rewrites CREATE UNIQUE INDEX to CREATE UNIQUE INDEX IF NOT EXISTS", () => {
    const out = makeStatementIdempotent(
      'CREATE UNIQUE INDEX "artifact_versions_artifact_id_version_key" ON "artifact_versions"("artifact_id", "version")',
    );
    expect(out).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "artifact_versions_artifact_id_version_key" ON "artifact_versions"("artifact_id", "version")',
    );
  });

  it("is idempotent — re-applying the transform is a no-op", () => {
    const once = makeStatementIdempotent(
      'CREATE TABLE "agents" ("id" TEXT NOT NULL PRIMARY KEY)',
    );
    const twice = makeStatementIdempotent(once);
    expect(twice).toBe(once);
  });

  it("leaves statements that already contain IF NOT EXISTS untouched", () => {
    const stmt = 'CREATE TABLE IF NOT EXISTS "agents" ("id" TEXT)';
    expect(makeStatementIdempotent(stmt)).toBe(stmt);
  });

  it("does not touch DROP / ALTER / INSERT / PRAGMA / SELECT statements", () => {
    const untouched = [
      'DROP TABLE "artifact_versions"',
      'ALTER TABLE "new_artifact_versions" RENAME TO "artifact_versions"',
      'INSERT INTO "new_artifact_versions" SELECT * FROM "artifact_versions"',
      "PRAGMA foreign_keys=OFF",
      'SELECT 1 FROM "agents"',
    ];
    for (const stmt of untouched) {
      expect(makeStatementIdempotent(stmt)).toBe(stmt);
    }
  });

  it("handles lowercase / mixed-case keywords", () => {
    expect(makeStatementIdempotent('create table "agents" ("id" TEXT)')).toBe(
      'create table IF NOT EXISTS "agents" ("id" TEXT)',
    );
    expect(
      makeStatementIdempotent('Create Unique Index "ix" On "agents"("id")'),
    ).toBe('Create Unique Index IF NOT EXISTS "ix" On "agents"("id")');
  });

  it("only rewrites the leading CREATE — does not touch substrings inside a CREATE TABLE body", () => {
    // A CREATE TABLE statement that mentions the word INDEX inside (e.g. in
    // a column comment / constraint) must not have its body rewritten.
    const stmt =
      'CREATE TABLE "agents" ("id" TEXT NOT NULL PRIMARY KEY, "note" TEXT NOT NULL DEFAULT \'see CREATE INDEX above\')';
    const out = makeStatementIdempotent(stmt);
    expect(out).toBe(
      'CREATE TABLE IF NOT EXISTS "agents" ("id" TEXT NOT NULL PRIMARY KEY, "note" TEXT NOT NULL DEFAULT \'see CREATE INDEX above\')',
    );
  });
});
