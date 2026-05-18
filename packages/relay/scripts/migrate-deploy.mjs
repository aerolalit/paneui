// scripts/migrate-deploy.mjs
//
// Runs `prisma migrate deploy` with a small bounded retry. The relay container
// applies migrations on every boot; if the database is briefly unavailable
// (e.g. a Postgres sidecar still starting), a single attempt would crash the
// container instead of waiting a few seconds for the DB to come up.
//
// The script is engine-aware: it detects sqlite vs postgres from DATABASE_URL
// (sharing detection with prisma-generate.mjs via ./_db-engine.mjs) and selects
// the matching schema. This matters because Prisma 6 derives the migrations
// directory from the schema file's own directory — the postgres schema lives in
// prisma/postgres/ so its migrations resolve from prisma/postgres/migrations/.
//
// Retry is bounded and quick: a handful of attempts with a short fixed delay.
// If every attempt fails the process exits non-zero, so a genuinely broken DB
// still surfaces as a failed boot rather than hanging forever.
//
// Usage:
//   node scripts/migrate-deploy.mjs            # auto-select schema from DATABASE_URL
//   node scripts/migrate-deploy.mjs --schema prisma/postgres/schema.prisma  # explicit override

import { spawnSync } from "node:child_process";
import { SCHEMAS, resolveEngine } from "./_db-engine.mjs";

const MAX_ATTEMPTS = 5;
const DELAY_MS = 3000;

const passthroughArgs = process.argv.slice(2);

// If the caller passed an explicit --schema, honour it verbatim. Otherwise pick
// the schema that matches the configured engine. The sqlite engine uses the
// default schema (prisma/schema.prisma) so no flag is added — preserving the
// pre-existing behaviour exactly.
let extraArgs = passthroughArgs;
if (!passthroughArgs.includes("--schema")) {
  const { key, source } = resolveEngine();
  if (key === "postgres") {
    extraArgs = [...passthroughArgs, "--schema", SCHEMAS.postgres];
  }
  console.log(
    `[migrate-deploy] DATABASE_URL via ${source} -> engine: ${key}` +
      (key === "postgres"
        ? ` (schema ${SCHEMAS.postgres})`
        : " (default schema)"),
  );
}

function attempt() {
  const r = spawnSync("npx", ["prisma", "migrate", "deploy", ...extraArgs], {
    stdio: "inherit",
  });
  return r.status === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let i = 1; i <= MAX_ATTEMPTS; i++) {
  if (attempt()) {
    process.exit(0);
  }
  if (i < MAX_ATTEMPTS) {
    process.stderr.write(
      `migrate deploy failed (attempt ${i}/${MAX_ATTEMPTS}); ` +
        `retrying in ${DELAY_MS}ms...\n`,
    );
    await sleep(DELAY_MS);
  }
}

process.stderr.write(
  `migrate deploy failed after ${MAX_ATTEMPTS} attempts; giving up.\n`,
);
process.exit(1);
