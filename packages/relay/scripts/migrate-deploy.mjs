// scripts/migrate-deploy.mjs
//
// Runs `prisma migrate deploy` with a small bounded retry. The relay container
// applies migrations on every boot; if the database is briefly unavailable
// (e.g. a Postgres sidecar still starting), a single attempt would crash the
// container instead of waiting a few seconds for the DB to come up.
//
// Schema selection: Prisma 7 reads `packages/relay/prisma.config.ts`
// automatically, and that config picks the schema (sqlite vs postgres) from
// `DATABASE_URL` plus supplies the driver adapter the migrate CLI needs to
// open a connection. The CLI's `--schema <path>` flag still works as an
// explicit override; any extra args this script receives are forwarded
// verbatim, so `npm run migrate:postgres:deploy` (which passes
// `--schema prisma/postgres/schema.prisma`) keeps working as belt-and-braces
// for environments where DATABASE_URL isn't trustworthy at deploy time.
//
// This script intentionally does no engine detection of its own anymore —
// previously it duplicated DATABASE_URL parsing to pick `--schema` ahead of
// the CLI, but with `prisma.config.ts` doing the same thing the duplication
// was just a second place that needed updating. Schema-selection logic now
// lives only in `prisma.config.ts`. The script's value is the retry loop.
//
// Retry is bounded and quick: a handful of attempts with a short fixed delay.
// If every attempt fails the process exits non-zero, so a genuinely broken DB
// still surfaces as a failed boot rather than hanging forever.
//
// Usage:
//   node scripts/migrate-deploy.mjs            # prisma.config.ts picks the schema
//   node scripts/migrate-deploy.mjs --schema prisma/postgres/schema.prisma  # explicit override

import { spawnSync } from "node:child_process";

const MAX_ATTEMPTS = 5;
const DELAY_MS = 3000;

const passthroughArgs = process.argv.slice(2);

function attempt() {
  const r = spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", ...passthroughArgs],
    {
      stdio: "inherit",
    },
  );
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
