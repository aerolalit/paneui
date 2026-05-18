// Unit tests for the shared database-engine detection in _db-engine.mjs.
// schemaKeyForUrl is the load-bearing piece: it decides whether the relay
// generates a sqlite or a postgres Prisma client and which schema
// `migrate deploy` runs against. Getting it wrong crashes the relay at boot.

import { describe, it, expect, afterEach } from "vitest";
import {
  SCHEMAS,
  schemaKeyForUrl,
  resolveEngine,
  relayDir,
} from "./_db-engine.mjs";

describe("schemaKeyForUrl", () => {
  it("maps postgresql:// and postgres:// URLs to postgres", () => {
    expect(schemaKeyForUrl("postgresql://user:pw@host:5432/db")).toBe(
      "postgres",
    );
    expect(schemaKeyForUrl("postgres://user:pw@host:5432/db")).toBe("postgres");
  });

  it("maps file: URLs to sqlite", () => {
    expect(schemaKeyForUrl("file:/app/data/pane.db")).toBe("sqlite");
    expect(schemaKeyForUrl("file:./dev.db")).toBe("sqlite");
  });

  it("defaults to sqlite when the URL is missing", () => {
    expect(schemaKeyForUrl(undefined)).toBe("sqlite");
    expect(schemaKeyForUrl("")).toBe("sqlite");
  });

  it("defaults to sqlite for an unrecognised protocol", () => {
    // The safe default — never silently treat an unknown URL as postgres.
    expect(schemaKeyForUrl("mysql://host/db")).toBe("sqlite");
    expect(schemaKeyForUrl("garbage")).toBe("sqlite");
  });

  it("does not match a substring — the protocol must be a prefix", () => {
    // A path or value that merely contains "postgres" is still sqlite.
    expect(schemaKeyForUrl("file:/var/postgres-backup/pane.db")).toBe("sqlite");
  });
});

describe("SCHEMAS", () => {
  it("points each engine at its schema file", () => {
    expect(SCHEMAS.sqlite).toBe("prisma/schema.prisma");
    // The postgres schema lives in its own dir so `migrate deploy` resolves
    // the matching prisma/postgres/migrations/ with no extra flag.
    expect(SCHEMAS.postgres).toBe("prisma/postgres/schema.prisma");
  });
});

describe("resolveEngine", () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it("resolves postgres from process.env.DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgresql://user:pw@host:5432/db";
    const r = resolveEngine();
    expect(r.key).toBe("postgres");
    expect(r.source).toBe("process.env");
  });

  it("resolves sqlite from a file: process.env.DATABASE_URL", () => {
    process.env.DATABASE_URL = "file:/app/data/pane.db";
    const r = resolveEngine();
    expect(r.key).toBe("sqlite");
    expect(r.source).toBe("process.env");
  });
});

describe("relayDir", () => {
  it("resolves to the packages/relay directory", () => {
    // The module lives in packages/relay/scripts; relayDir is one level up.
    expect(relayDir.endsWith("packages/relay")).toBe(true);
  });
});
