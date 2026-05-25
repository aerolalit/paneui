// `pane agent claim <code>` — bind this agent to a human via a one-shot
// claim code the human generated in their settings UI.
//
// Flow (§6.1):
//   1. Alice opens Settings → "Claim an agent" → relay mints a one-shot code,
//      shows it to her once, 15-min TTL.
//   2. Alice hands the code to the agent out-of-band (this CLI invocation
//      is exactly that handoff).
//   3. CLI calls POST /v1/agents/claim with the calling agent's API key.
//   4. Relay binds Agent.ownerHumanId = alice.id, migrates surface ownership.
//
// The CLI does NOT print the human's email or id — only the relay's response,
// which is { ok, owner_human_id, claimed_at }. The agent's existing API key
// keeps working.

import { PaneClient, PaneApiError } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { resolveConfig } from "../config.js";
import { printJson, fail } from "../output.js";

const KNOWN_FLAGS: string[] = ["url", "api-key"];
const KNOWN_BOOLS: string[] = [];

export const claimHelp = `pane agent claim — claim this agent for a human

Usage:
  pane agent claim <code>

Binds the calling agent to the human whose one-shot claim code is provided.
The human generates the code in their settings UI (or via the relay's
POST /v1/self/claim-codes endpoint) and hands it to the agent out-of-band.

Arguments:
  <code>              The one-shot claim code (begins with cc_). Required.

Options:
  --url <url>         Relay base URL. Falls back to PANE_URL / config file.
  --api-key <key>     Agent API key. Falls back to PANE_API_KEY / config file.
  -h, --help          Show this help.

Output (stdout, JSON):
  { ok: true, owner_human_id, claimed_at }

Errors:
  invalid_code             code is unknown, expired, or already consumed
  agent_already_claimed    this agent already has an owning human

Notes:
  This is a one-way operation. To rotate the owner, revoke this agent
  (\`pane key revoke\`) and register a new one.`;

export async function runClaim(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane agent claim");

  const code = args.positionals[0];
  if (!code) {
    fail(
      "missing required argument: <code> — run 'pane agent claim --help'",
      "invalid_args",
    );
    return;
  }

  const creds = resolveConfig(args);
  const client = new PaneClient({ url: creds.url, apiKey: creds.apiKey });

  try {
    const result = await client.claimAgent(code);
    printJson(result);
  } catch (err) {
    if (err instanceof PaneApiError) {
      fail(err.message, err.code);
      return;
    }
    throw err;
  }
}
