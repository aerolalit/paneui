import { defineConfig } from "vitest/config";

// Bound the forks-pool worker count for the relay test suites.
//
// Why this exists: the e2e suite (`*.e2e.test.ts` / `*.integration.test.ts`)
// runs against a real database, and on Postgres the default forks pool —
// which spawns one worker per CPU and runs every test file in parallel — was
// intermittently flaky on CI's `e2e (postgres)` job:
//
//   - Concurrent `TRUNCATE ... CASCADE` calls in the per-test beforeEach hook
//     deadlock (SQLSTATE 40P01) on shared lock-ordering, even with each file
//     in its own schema. (Also retried in test-helpers/db.ts as a second line
//     of defence.)
//   - N parallel files × each file's PrismaClient pool exhaust Postgres's
//     default max_connections (100), surfacing as "Failed to start forks
//     worker" plus scattered, unrelated cross-file failures.
//
// sqlite never hits either — each file gets its own on-disk DB file with no
// shared connection ceiling — which is why only the Postgres leg flaked.
//
// The same suite is reliably green when run serially or with a small, bounded
// number of workers. Rather than force fully-serial (`--no-file-parallelism`),
// which roughly triples e2e wall-clock, we cap the pool at 4 forks. Combined
// with the per-client `connection_limit=5` set in test-helpers/db.ts, that
// bounds peak DB usage to ~4×5 = 20 connections (plus a couple of short-lived
// admin pools) — comfortably under 100 — and keeps at most 4 TRUNCATEs racing,
// which the deadlock-retry absorbs. 4 was the highest value that stayed green
// across repeated local reproduction runs; raise it only with the same
// repeated-run verification.
//
// minForks is left at the default (no floor) so a developer's machine with
// fewer cores isn't forced to over-subscribe.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
  },
});
