// scripts/_db-engine.mjs
//
// Database-engine detection used by prisma-generate.mjs. Maps a DATABASE_URL
// to the right schema file so client codegen picks the engine the runtime
// will actually connect against.
//
// Used to also be shared with migrate-deploy.mjs, but Prisma 7's
// prisma.config.ts (packages/relay/prisma.config.ts) now does the same
// schema selection for migrate / studio / introspection — so those CLI
// surfaces all read DATABASE_URL through the config. `prisma generate` is
// the lone holdout: it does codegen before the config's connection layer
// runs, so it still needs an explicit `--schema` path from this module.
//
// No dependencies — a tiny .env reader is inlined (the project keeps `.env`
// gitignored, so absence is normal and handled gracefully).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Absolute path to packages/relay (this file lives in packages/relay/scripts). */
export const relayDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Schema file paths, relative to relayDir, keyed by engine. */
export const SCHEMAS = {
  sqlite: "prisma/schema.prisma",
  postgres: "prisma/postgres/schema.prisma",
};

/** Read DATABASE_URL from packages/relay/.env if it isn't already in the env. */
export function databaseUrlFromEnvFile() {
  const envPath = path.join(relayDir, ".env");
  if (!existsSync(envPath)) return undefined;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/** Map a DATABASE_URL to an engine key, defaulting to the safe sqlite engine. */
export function schemaKeyForUrl(url) {
  if (!url) return "sqlite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgres";
  }
  // `file:` URLs, and anything unrecognised, fall back to sqlite (the default).
  return "sqlite";
}

/**
 * Resolve the engine key from process.env / .env, returning both the key and a
 * human-readable description of where the URL came from (for logging).
 */
export function resolveEngine() {
  const url = process.env.DATABASE_URL ?? databaseUrlFromEnvFile();
  const key = schemaKeyForUrl(url);
  const source = process.env.DATABASE_URL
    ? "process.env"
    : url
      ? ".env file"
      : "default (DATABASE_URL unset)";
  return { key, source, url };
}
