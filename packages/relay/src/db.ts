import path from "node:path";
import { PrismaClient } from "@prisma/client";

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
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: resolveSqliteUrl(databaseUrl) });
}
