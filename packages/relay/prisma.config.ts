// Prisma 7 configuration — replaces the `datasource.url = env("...")` line
// that Prisma 6 schemas carried. The relay supports two engines (sqlite for
// self-host, postgres for the hosted build), each with its own schema file
// under prisma/. The CLI receives `--schema <path>` from scripts/ for the
// deterministic-engine cases; we also default the schema here so a bare
// `npx prisma ...` from the relay directory picks the right one based on
// DATABASE_URL.
//
// Note: `migrate deploy` reads the URL out of `datasource.url` below — that's
// distinct from the runtime PrismaClient connection, which uses a driver
// adapter constructed in packages/relay/src/db.ts. Prisma 7 dropped the Rust
// query engine, so the RUNTIME has to bring its own driver (better-sqlite3 /
// pg); `migrate` operations run their own connection internally and just
// need the URL. Both code paths read DATABASE_URL from process.env, so they
// always target the same database.
//
// Why ONE config file: Prisma 7 walks up from cwd looking for prisma.config.ts
// and uses the first match. Splitting by engine would require passing
// `--config` everywhere; choosing the schema inside the single file keeps
// the existing migrate-deploy.mjs / prisma-generate.mjs invocations unchanged.

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Hand-rolled .env reader. Prisma 7 dropped automatic env loading from the
// CLI, and we don't want a dotenv dev-dependency just for this file. Mirrors
// the inline reader in scripts/_db-engine.mjs.
function loadEnvFile(): void {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(import.meta.dirname, ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[1]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env.DATABASE_URL = value;
    return;
  }
}
loadEnvFile();

const databaseUrl = process.env.DATABASE_URL ?? "file:./data/pane.db";
const isPostgres =
  databaseUrl.startsWith("postgres://") ||
  databaseUrl.startsWith("postgresql://");

export default defineConfig({
  // `--schema <path>` on the CLI overrides this; the scripts in scripts/
  // pass it through explicitly for the deterministic-engine cases
  // (e.g. pretest:browser forces sqlite). The default here is engine-matched
  // so a bare `npx prisma migrate deploy` from packages/relay/ works for
  // both self-hosters and hosted-relay deploys without flags.
  schema: isPostgres ? "prisma/postgres/schema.prisma" : "prisma/schema.prisma",

  datasource: {
    url: databaseUrl,
  },
});
