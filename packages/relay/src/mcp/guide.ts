// Relay-side composition of the MCP-flavoured pane guide.
//
// Reads skills/pane/MCP-INVOCATION.md + skills/pane/SKILL.md at boot (same
// candidate-path discipline as routes/skill.ts) and composes the MCP guide via
// @paneui/mcp's pure composeMcpGuide (MCP invocation layer + the conceptual
// core extracted from SKILL.md). The result is served at /skills/pane/MCP.md
// and returned by the MCP `get_skill` tool / `pane_guide` prompt+resource.
//
// The skill version comes from the SAME `<!-- pane skill vX.Y.Z -->` comment
// the CLI skill route parses, so the CLI skill and the MCP guide always report
// one version (cut-release.sh bumps it).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeMcpGuide } from "@paneui/mcp/guide";

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function loadFile(name: string): string {
  const candidates = [
    resolve(PACKAGE_ROOT, "skills", "pane", name),
    resolve(PACKAGE_ROOT, "..", "..", "skills", "pane", name),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(
    `pane relay: skill file ${name} not found — looked in ${candidates.join(", ")}`,
  );
}

const SKILL_MD = loadFile("SKILL.md");
const MCP_INVOCATION_MD = loadFile("MCP-INVOCATION.md");

export const MCP_GUIDE = composeMcpGuide(MCP_INVOCATION_MD, SKILL_MD);

const SKILL_VERSION_RE = /<!--\s*pane skill v([0-9]+\.[0-9]+\.[0-9]+)\s*-->/;
const m = SKILL_MD.match(SKILL_VERSION_RE);
export const MCP_GUIDE_VERSION = m ? m[1]! : "0.0.0";
