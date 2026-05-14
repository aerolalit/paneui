import path from "node:path";
import { PrismaClient } from "@prisma/client";
import config from "./config.js";

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

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ datasourceUrl: resolveSqliteUrl(config.DATABASE_URL) });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
