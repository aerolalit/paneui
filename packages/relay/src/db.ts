import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

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

function isPostgresUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export interface DbHandle {
  prisma: PrismaClient;
  /**
   * Disconnect Prisma and (for the postgres path) drain the underlying `pg`
   * connection pool. Call from shutdown handlers and test teardown.
   */
  close: () => Promise<void>;
}

export interface CreatePrismaClientOptions {
  /**
   * Max connections in the postgres `pg.Pool`. Ignored for sqlite. Defaults
   * to 10 (matches the standard `pg` library default). Plumbed from the
   * DATABASE_POOL_MAX env var in src/config.ts.
   */
  poolMax?: number;
}

const DEFAULT_POOL_MAX = 10;

/**
 * Factory for a Prisma client bound to a specific database URL.
 *
 * The relay constructs exactly one of these at startup (see src/index.ts) and
 * threads the resulting `prisma` through the app via dependency injection;
 * tests construct their own against an isolated database. There is
 * intentionally no module-level singleton here so the client is never an
 * implicit ambient dependency.
 *
 * Engine selection:
 *   - postgres:// / postgresql:// → @prisma/adapter-pg over the node `pg`
 *     driver. The Rust query engine is bypassed, so standard `pg` OTel
 *     instrumentation can surface DB calls as RemoteDependencyData.
 *   - file: (sqlite) → the bundled Rust query engine, unchanged.
 *
 * Returns a `{ prisma, close }` handle: `close()` disposes Prisma and, on the
 * postgres path, drains the pg pool.
 */
export function createPrismaClient(
  databaseUrl: string,
  options: CreatePrismaClientOptions = {},
): DbHandle {
  if (isPostgresUrl(databaseUrl)) {
    const max = options.poolMax ?? DEFAULT_POOL_MAX;
    // Pull `?schema=...` off the URL. The Rust query engine reads this query
    // param off the connection string itself; the node `pg` driver does not.
    // We surface it two ways so BOTH typed Prisma queries and raw SQL land in
    // the right schema:
    //   1) Pass `{ schema }` to PrismaPg — qualifies typed queries.
    //   2) Set `options=-c search_path=...` on every pg connection — makes
    //      `$executeRawUnsafe` / `$queryRawUnsafe` see the same schema. The
    //      test harness uses raw migration SQL, so without this the per-file
    //      schema isolation in test-helpers/db.ts would silently fall back
    //      to writing into `public`.
    const parsed = new URL(databaseUrl);
    const schema = parsed.searchParams.get("schema") ?? undefined;
    const poolConfig: import("pg").PoolConfig = {
      connectionString: databaseUrl,
      max,
    };
    if (schema) {
      // `public` after the schema keeps Prisma's own engine internals (and
      // extensions like pg_trgm) reachable when the per-test schema is the
      // primary.
      poolConfig.options = `-c search_path="${schema}",public`;
    }
    const pool = new Pool(poolConfig);
    const adapter = new PrismaPg(pool, schema ? { schema } : undefined);
    const prisma = new PrismaClient({ adapter });
    return {
      prisma,
      close: async () => {
        await prisma.$disconnect();
        await pool.end();
      },
    };
  }

  const prisma = new PrismaClient({
    datasourceUrl: resolveSqliteUrl(databaseUrl),
  });
  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
    },
  };
}
