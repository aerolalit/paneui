// scripts/check-schema-sync.mjs
//
// The relay ships two Prisma schema files — prisma/schema.prisma (sqlite) and
// prisma/postgres/schema.prisma (postgres) — that MUST describe the same data
// model. They differ only in provider-specific bits: the `datasource` block,
// and provider-specific field annotations (e.g. `@db.BigInt`).
//
// This check normalises both files down to just their model/enum definitions,
// strips provider-specific annotations, and fails if anything else diverges.
// Run it locally with `npm run check:schema-sync --workspace @paneui/relay`;
// CI runs it on every push/PR.
//
// No dependencies — pure Node.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const relayDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SQLITE_SCHEMA = path.join(relayDir, "prisma/schema.prisma");
const POSTGRES_SCHEMA = path.join(relayDir, "prisma/postgres/schema.prisma");

// Provider-specific native-type annotations that are allowed to differ between
// the two schemas. They are stripped before comparison.
const PROVIDER_ANNOTATION_RE = /\s*@db\.[A-Za-z0-9]+(\([^)]*\))?/g;

/**
 * Reduce a Prisma schema file to a canonical, provider-agnostic representation
 * of its model and enum definitions:
 *  - drops `datasource` and `generator` blocks (provider config lives there)
 *  - drops comments and blank lines
 *  - strips `@db.*` native-type annotations
 *  - collapses whitespace so cosmetic formatting differences don't trip the check
 */
function normalizeSchema(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);

  const out = [];
  let depth = 0; // brace depth inside the current block
  let skipBlock = false; // true while inside a datasource/generator block

  for (const rawLine of lines) {
    // Drop full-line and trailing comments.
    let line = rawLine.replace(/\/\/.*$/, "");
    line = line.replace(PROVIDER_ANNOTATION_RE, "");
    line = line.trim();
    if (!line) continue;

    // Detect the start of a top-level block.
    if (depth === 0) {
      const blockMatch = /^(datasource|generator|model|enum)\b/.exec(line);
      if (blockMatch) {
        skipBlock =
          blockMatch[1] === "datasource" || blockMatch[1] === "generator";
      }
    }

    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;

    if (!skipBlock) {
      // Collapse internal whitespace so alignment padding doesn't matter.
      out.push(line.replace(/\s+/g, " "));
    }

    depth += opens - closes;
    if (depth === 0) skipBlock = false;
  }

  return out;
}

function main() {
  const sqlite = normalizeSchema(SQLITE_SCHEMA);
  const postgres = normalizeSchema(POSTGRES_SCHEMA);

  if (sqlite.join("\n") === postgres.join("\n")) {
    console.log(
      "[check-schema-sync] OK — schema.prisma and postgres/schema.prisma " +
        "describe the same data model.",
    );
    process.exit(0);
  }

  console.error(
    "[check-schema-sync] FAIL — the two Prisma schemas have diverged.\n" +
      "  schema.prisma and postgres/schema.prisma must keep identical model\n" +
      "  and enum definitions (only datasource/generator blocks and @db.*\n" +
      "  annotations may differ). Differences (- sqlite, + postgres):\n",
  );

  // Minimal line-by-line diff — enough to point at the divergent lines.
  const max = Math.max(sqlite.length, postgres.length);
  for (let i = 0; i < max; i++) {
    const a = sqlite[i];
    const b = postgres[i];
    if (a !== b) {
      if (a !== undefined) console.error(`  - ${a}`);
      if (b !== undefined) console.error(`  + ${b}`);
    }
  }
  process.exit(1);
}

main();
