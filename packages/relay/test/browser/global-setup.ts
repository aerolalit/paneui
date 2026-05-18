// Playwright global setup for the phase-3 browser test.
//
// The relay ships two Prisma schemas that generate to the SAME `@prisma/client`:
//   - prisma/schema.prisma          (sqlite, the default)
//   - prisma/postgres/schema.prisma  (postgresql, the hosted build)
// Whichever `prisma generate` ran last wins. The browser harness boots the relay
// against a throwaway SQLite `file:` database, so it needs the SQLite-targeted
// client. If the Postgres client happens to be generated, the harness fails with
// "the URL must start with the protocol `file:`".
//
// `pretest:browser` already runs `prisma generate --schema prisma/schema.prisma`,
// but this global setup makes the test self-contained and deterministic even
// when invoked directly via `npx playwright test` (which skips the npm
// `pretest:browser` hook).

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export default function globalSetup(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const relayRoot = resolve(here, "..", "..");
  execFileSync(
    "npx",
    ["prisma", "generate", "--schema", "prisma/schema.prisma"],
    { cwd: relayRoot, stdio: "inherit" },
  );
}
