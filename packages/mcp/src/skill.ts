// Fetch the relay's auto-updating SKILL.md over plain HTTP.
//
// Mirrors `pane skill show|version` (packages/cli/src/commands/skill.ts): the
// relay serves its skill at GET /skills/pane/SKILL.md and the version at GET
// /skills/pane/SKILL.md/version. Both routes are UNAUTHENTICATED — no API key
// needed — so an MCP client can self-teach the Pane workflow before (or without)
// provisioning a key. We don't go through PaneClient here precisely because no
// auth is required and the skill routes are exempt from the version-skew check.

import { VERSION } from "./version.js";

/**
 * GET the relay's full SKILL.md markdown. `version: true` instead fetches just
 * the relay's reported skill version (the "is my local copy stale?" probe).
 * Throws on a non-2xx or network failure with a message the tool layer can
 * surface.
 */
export async function fetchSkill(
  relayUrl: string,
  opts: { version?: boolean } = {},
): Promise<{ markdown?: string; version?: string }> {
  const base = relayUrl.replace(/\/$/, "");
  if (opts.version) {
    const target = base + "/skills/pane/SKILL.md/version";
    const res = await fetchOrThrow(target);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const version =
      body !== null &&
      typeof body === "object" &&
      typeof (body as { version?: unknown }).version === "string"
        ? (body as { version: string }).version
        : "0.0.0";
    return { version };
  }
  const target = base + "/skills/pane/SKILL.md";
  const res = await fetchOrThrow(target);
  const markdown = await res.text();
  return { markdown };
}

async function fetchOrThrow(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-pane-cli-version": VERSION } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`could not reach ${url}: ${msg}`, { cause: e });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `relay returned ${res.status} for ${url}${
        body ? ": " + body.slice(0, 200) : ""
      }`,
    );
  }
  return res;
}
