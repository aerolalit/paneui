// scripts/migrate-deploy.mjs
//
// Runs `prisma migrate deploy` with a small bounded retry. The relay container
// applies migrations on every boot; if the database is briefly unavailable
// (e.g. a Postgres sidecar still starting), a single attempt would crash the
// container instead of waiting a few seconds for the DB to come up.
//
// Retry is bounded and quick: a handful of attempts with a short fixed delay.
// If every attempt fails the process exits non-zero, so a genuinely broken DB
// still surfaces as a failed boot rather than hanging forever.
//
// Usage:
//   node scripts/migrate-deploy.mjs            # default schema (sqlite)
//   node scripts/migrate-deploy.mjs --schema prisma/schema.postgres.prisma

import { spawnSync } from "node:child_process";

const MAX_ATTEMPTS = 5;
const DELAY_MS = 3000;

const extraArgs = process.argv.slice(2);

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
