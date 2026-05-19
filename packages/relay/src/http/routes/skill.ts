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

const skill = new Hono<AppEnv>();

skill.get("/pane/SKILL.md", (c) =>
  c.body(SKILL_MD, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    // Non-secret static content — safe to cache, unlike the bridge routes.
    "Cache-Control": "public, max-age=3600",
  }),
);

export default skill;
