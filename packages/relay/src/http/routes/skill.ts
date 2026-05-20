import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "../env.js";

// Serves the pane agent skill verbatim at GET /skills/pane/SKILL.md so an agent
// can fetch it straight from the relay it talks to — no repo clone, and the
// skill is always version-matched to that relay's image.

// PACKAGE_ROOT resolves to packages/relay/ in every run mode (tsx-from-source,
// node-from-dist, and inside the Docker image). This module lives at
// http/routes/skill — three levels below the src/ (or dist/) root — so three
// `..` reach the package root.
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

// Read once at startup (like the bridge's SHIM_JS/SHELL_JS) so a missing file
// fails the boot loudly instead of 500ing per request. The skill is a ~16 KB
// static doc — editing it requires a relay restart, which is fine.
function loadSkill(): string {
  // Candidate 1: copied into the relay package — the Docker image layout.
  // Candidate 2: the monorepo-root skills/ dir — running from a source checkout.
  const candidates = [
    resolve(PACKAGE_ROOT, "skills", "pane", "SKILL.md"),
    resolve(PACKAGE_ROOT, "..", "..", "skills", "pane", "SKILL.md"),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `pane relay: skill file not found — looked in ${candidates.join(", ")}`,
  );
}

const SKILL_MD = loadSkill();

// The skill carries its own version in a plain HTML comment near the top:
//   <!-- pane skill v1.0.0 -->
// We parse it at boot. Stored in an HTML comment (not YAML frontmatter)
// because the local file on the agent's machine may have been format-
// converted by its runtime (Cursor rewrites frontmatter, AGENTS.md
// concatenators strip it) — comments survive every markdown flavour and
// stay readable inline by both humans and the CLI's same-regex parser.
//
// Falls back to "0.0.0" if the comment is missing — an old image without
// the comment still serves a sane version, and the agent comparing its
// (presumably newer) local version to 0.0.0 will skip update rather than
// loop. The relay doesn't validate that the version exists; the bump
// discipline lives in PR review.
const SKILL_VERSION_RE = /<!--\s*pane skill v([0-9]+\.[0-9]+\.[0-9]+)\s*-->/;
const SKILL_VERSION_MATCH = SKILL_MD.match(SKILL_VERSION_RE);
const SKILL_VERSION = SKILL_VERSION_MATCH ? SKILL_VERSION_MATCH[1]! : "0.0.0";

const skill = new Hono<AppEnv>();

skill.get("/pane/SKILL.md", (c) =>
  c.body(SKILL_MD, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    // Non-secret static content — safe to cache, unlike the bridge routes.
    "Cache-Control": "public, max-age=3600",
  }),
);

// GET /skills/pane/SKILL.md/version — the version-only probe used by
// `pane skill version` for the "is my local skill stale?" check. Tiny
// payload (~30 bytes) so an agent can call it at every session start
// without thinking about the bandwidth. Same 1-hour cache as the full
// skill — they share the same boot-snapshot lifecycle.
skill.get("/pane/SKILL.md/version", (c) =>
  c.json({ version: SKILL_VERSION }, 200, {
    "Cache-Control": "public, max-age=3600",
  }),
);

export default skill;
