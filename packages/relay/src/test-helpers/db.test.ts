// Unit tests for the migration-idempotency error matcher in db.ts.
//
// `isIdempotentMigrationError` is the belt-and-suspenders layer that swallows
// "already exists" failures inside the per-statement migration loop, for the
// narrow window between a re-entry call and the sentinel-table guard taking
// effect. The primary defence against re-applies is the sentinel itself
// (`migrationsAlreadyApplied` + `markMigrationsApplied`); the regex set here
// catches the first-pass-then-immediate-second-pass race that produced the
// flake in issue #118.
//
// Regression target: issue #118. The matcher previously missed SQLite's
// "there is already another table or index with this name" wording, which
// is what bubbled up when the migration race produced the duplicate
// `artifact_versions` error and broke CI on ~1/3 of runs.

import { describe, it, expect } from "vitest";
import { isIdempotentMigrationError } from "./db.js";

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
