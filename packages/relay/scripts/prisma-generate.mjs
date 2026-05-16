// scripts/prisma-generate.mjs
//
// Picks the Prisma schema whose datasource `provider` matches the configured
// DATABASE_URL, then runs `prisma generate` against it. This exists because
// the relay ships two schema files (sqlite + postgres) that both generate to
// the SAME @prisma/client — so whichever `prisma generate` ran last wins, and
// a stale (wrong-provider) client makes the server crash at boot.
//
// Usage:
//   node scripts/prisma-generate.mjs            # auto-select from DATABASE_URL
//   node scripts/prisma-generate.mjs sqlite     # force the sqlite schema
//   node scripts/prisma-generate.mjs postgres   # force the postgres schema
//
// No dependencies — a tiny .env reader is inlined (the project keeps `.env`
// gitignored, so absence is normal and handled gracefully).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMAS = {
  sqlite: "prisma/schema.prisma",
  postgres: "prisma/schema.postgres.prisma",
};

/** Read DATABASE_URL from packages/relay/.env if it isn't already in the env. */
function databaseUrlFromEnvFile() {
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

/** Map a DATABASE_URL to a schema key, defaulting to the safe sqlite schema. */
function schemaKeyForUrl(url) {
  if (!url) return "sqlite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgres";
  }
  // `file:` URLs, and anything unrecognised, fall back to sqlite (the default).
  return "sqlite";
}

function main() {
  const forced = process.argv[2];
  let key;

  if (forced) {
    if (!SCHEMAS[forced]) {
      console.error(
        `[prisma-generate] unknown argument "${forced}" — expected "sqlite" or "postgres"`,
      );
      process.exit(1);
    }
    key = forced;
    console.log(`[prisma-generate] forced schema: ${key}`);
  } else {
    const url = process.env.DATABASE_URL ?? databaseUrlFromEnvFile();
    key = schemaKeyForUrl(url);
    const source = process.env.DATABASE_URL
      ? "process.env"
      : url
        ? ".env file"
        : "default (DATABASE_URL unset)";
    console.log(`[prisma-generate] DATABASE_URL via ${source} -> schema: ${key}`);
  }

  const schema = SCHEMAS[key];
  const provider = key === "postgres" ? "postgresql" : "sqlite";
  console.log(`[prisma-generate] generating client for provider "${provider}" (${schema})`);

  const result = spawnSync(
    "npx",
    ["prisma", "generate", "--schema", schema],
    { cwd: relayDir, stdio: "inherit", shell: process.platform === "win32" },
  );

  if (result.error) {
    console.error(`[prisma-generate] failed to run prisma: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

main();
