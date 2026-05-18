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
// Engine detection (and the tiny .env reader) is shared with
// migrate-deploy.mjs via ./_db-engine.mjs.

import { spawnSync } from "node:child_process";
import { relayDir, SCHEMAS, resolveEngine } from "./_db-engine.mjs";

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
    const { key: detected, source } = resolveEngine();
    key = detected;
    console.log(
      `[prisma-generate] DATABASE_URL via ${source} -> schema: ${key}`,
    );
  }

  const schema = SCHEMAS[key];
  const provider = key === "postgres" ? "postgresql" : "sqlite";
  console.log(
    `[prisma-generate] generating client for provider "${provider}" (${schema})`,
  );

  const result = spawnSync("npx", ["prisma", "generate", "--schema", schema], {
    cwd: relayDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(
      `[prisma-generate] failed to run prisma: ${result.error.message}`,
    );
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

main();
