import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// SQLite path resolution gotcha: the Prisma CLI resolves `file:./...` URLs
// relative to `schema.prisma`'s location (i.e. `prisma/`), while the runtime
// client resolves relative to `process.cwd()`. To keep the migrate CLI and the
// runtime pointing at the same file, we re-resolve relative-`file:` URLs
// against `<cwd>/prisma/` here and pass the absolute path to PrismaClient.
function resolveSqliteUrl(url: string): string {
  if (!url.startsWith("file:") || url.startsWith("file:/")) return url;
  const rel = url.slice("file:".length);
  const schemaDir = path.resolve(process.cwd(), "prisma");
  return "file:" + path.resolve(schemaDir, rel);
}

// Factory for a Prisma client bound to a specific database URL. The relay
// constructs exactly one of these at startup (see src/index.ts) and threads it
// through the app via dependency injection; tests construct their own against
// an isolated database. There is intentionally no module-level singleton here
// so the client is never an implicit ambient dependency.
//
// Prisma 7 dropped the Rust query engine; connections go through driver
// adapters that wrap a native driver (better-sqlite3 / pg). The factory
// picks the adapter from the URL scheme: `postgres://` / `postgresql://` →
// PrismaPg + pg.Pool; everything else (including `file:` and bare paths) →
// PrismaBetterSqlite3. Both adapters + native drivers are required deps —
// each engine is first-class (sqlite is the self-host default, postgres is
// the hosted backend). The native binding only loads when the adapter
// constructs a connection, so the inactive engine's .node binary stays
// dormant.
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const isPostgres =
    databaseUrl.startsWith("postgres://") ||
    databaseUrl.startsWith("postgresql://");

  if (isPostgres) {
    // Honour the `?schema=<name>` URL convention. Prisma 6's query engine
    // understood it natively (it would set search_path AND qualify generated
    // SQL with the schema name); the Prisma 7 driver adapter splits those
    // two responsibilities and we need to wire both ends:
    //   1. pg.Pool `options: -c search_path=<schema>` so the connection's
    //      runtime schema resolution lands in the right namespace.
    //   2. `new PrismaPg(pool, { schema })` so Prisma's generated SQL
    //      qualifies every table reference with the same schema name
    //      (without this, queries hit `public.agents` even when the
    //      connection's search_path points elsewhere).
    // The test harness relies on this to give every test file its own
    // private postgres schema; without both ends, all test files collapse
    // to `public` and foreign-key constraints fire on cross-contaminated
    // rows.
    const u = new URL(databaseUrl);
    const schema = u.searchParams.get("schema");
    // Honour `?connection_limit=<n>` as the max pool size. Under the Prisma 7
    // driver adapter the pg.Pool — not Prisma's engine — owns connection
    // management, and pg.Pool defaults to max=10. The standard Prisma URL knob
    // for this is `connection_limit`, which the pg driver itself ignores, so
    // we read it here and map it onto pg.Pool's `max`. This is what bounds the
    // parallel-fork e2e suite (see test-helpers/db.ts) so N concurrent files ×
    // their pools stay under Postgres's max_connections; it also lets a hosted
    // deployment size the relay's own pool via the URL.
    const connLimitRaw = u.searchParams.get("connection_limit");
    const connLimit =
      connLimitRaw !== null && Number.isInteger(Number(connLimitRaw))
        ? Number(connLimitRaw)
        : undefined;
    // Strip Prisma-specific query params before handing the URL to pg —
    // `schema` and `connection_limit` are Prisma conventions, not standard pg
    // connection parameters, and leaving them in the URL isn't worth the
    // ambiguity.
    u.searchParams.delete("schema");
    u.searchParams.delete("connection_limit");
    const cleanUrl = u.toString();
    const poolConfig: pg.PoolConfig = { connectionString: cleanUrl };
    if (schema) {
      poolConfig.options = `-c search_path="${schema}"`;
    }
    if (connLimit !== undefined && connLimit > 0) {
      poolConfig.max = connLimit;
    }
    return new PrismaClient({
      adapter: new PrismaPg(
        new pg.Pool(poolConfig),
        schema ? { schema } : undefined,
      ),
    });
  }

  return new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: resolveSqliteUrl(databaseUrl) }),
  });
}
