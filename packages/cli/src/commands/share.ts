// `pane share <pane-id>` — manage identity sharing on a pane.
//
//   pane share <pane-id> --email <addr> [--role participant|viewer]
//       Invite a human by email (upsert). Role defaults to participant
//       (read + emit); viewer is read-only.
//   pane share <pane-id> --public | --private
//       Toggle public visibility. A public pane opens READ-ONLY to anyone at
//       /p/<pane-id> without logging in.
//   pane share <pane-id> --list
//       Show the pane's is_public state + every grant.
//   pane share <pane-id> --revoke <grant-id>
//       Remove one grant (idempotent).
//
// One verb per invocation. Output is machine-readable JSON on stdout; errors
// are `{"error":{"code","message"}}` on stderr with a non-zero exit.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

// Value-flags this command accepts (in addition to the global --url/--api-key/
// --profile). Boolean flags (--public/--private/--list) are registered in
// index.ts's BOOLEAN_FLAGS so the parser doesn't swallow the next token.
const VALUE_FLAGS = ["email", "role", "revoke"];
const BOOL_FLAGS = ["public", "private", "list"];

export const shareHelp = `pane share — manage identity sharing on a pane

A pane has two layered share mechanisms on top of participant tokens:
  - public:     anyone with the /p/<pane-id> URL can VIEW it (read-only),
                no login required.
  - invitation: specific humans (by email) get a grant. A 'participant'
                grant can read AND emit page events; a 'viewer' grant is
                read-only. A pending invite binds to the human on their
                first magic-link login.

Usage:
  pane share <pane-id> --email <addr> [--role participant|viewer]
  pane share <pane-id> --public
  pane share <pane-id> --private
  pane share <pane-id> --list
  pane share <pane-id> --revoke <grant-id>

Verbs (exactly one per call):
  --email <addr>          Invite a human by email (upsert). --role defaults
                          to 'participant'. Re-inviting the same address
                          updates the role in place. Returns the grant
                          { id, human_id, invite_email, role, accepted_at }.
  --public                Make the pane public (read-only for anyone with the
                          /p/<id> URL). Returns { pane_id, is_public }.
  --private               Revert the pane to invite-only.
  --list                  Show { pane_id, is_public, items: [grant...] }.
  --revoke <grant-id>     Remove one grant. Idempotent (unknown id still OK).

Options:
  --role <participant|viewer>  Role for --email (default participant).
  --url <url>                  Relay base URL (overrides PANE_URL).
  --api-key <key>              Agent API key (overrides PANE_API_KEY).
  -h, --help                   Show this help.

Output: stdout is machine-readable JSON.`;

export async function runShare(args: ParsedArgs): Promise<void> {
  if (args.bools.has("help")) {
    process.stdout.write(shareHelp + "\n");
    return;
  }

  assertKnownFlags(args, VALUE_FLAGS, BOOL_FLAGS, "pane share");

  // positionals[0] is the verb slot in the dispatcher's view, but `share` is a
  // flat top-level command: positionals[0] is the pane id.
  const paneId = args.positionals[0];
  if (!paneId) {
    fail(
      "missing <pane-id> — usage: pane share <pane-id> --email <addr> | --public | --private | --list | --revoke <grant-id>",
      "invalid_args",
    );
  }

  // Determine which verb was requested; reject ambiguous combinations so the
  // caller's intent is never guessed.
  const hasEmail = args.flags.has("email");
  const hasPublic = args.bools.has("public");
  const hasPrivate = args.bools.has("private");
  const hasList = args.bools.has("list");
  const hasRevoke = args.flags.has("revoke");

  const verbCount =
    (hasEmail ? 1 : 0) +
    (hasPublic ? 1 : 0) +
    (hasPrivate ? 1 : 0) +
    (hasList ? 1 : 0) +
    (hasRevoke ? 1 : 0);

  if (verbCount === 0) {
    fail(
      "missing verb — pass exactly one of --email <addr>, --public, --private, --list, --revoke <grant-id>",
      "invalid_args",
    );
  }
  if (verbCount > 1) {
    fail(
      "ambiguous — pass exactly one of --email, --public, --private, --list, --revoke",
      "invalid_args",
    );
  }

  const client = makeClient(args);

  try {
    if (hasList) {
      const res = await client.listGrants(paneId!);
      printJson(res);
      return;
    }

    if (hasPublic || hasPrivate) {
      const res = await client.setPaneVisibility(paneId!, hasPublic);
      printJson(res);
      return;
    }

    if (hasRevoke) {
      const grantId = args.flags.get("revoke");
      if (!grantId) {
        fail(
          "missing <grant-id> — usage: pane share <pane-id> --revoke <grant-id>",
          "invalid_args",
        );
      }
      await client.revokeGrant(paneId!, grantId!);
      printJson({ pane_id: paneId, grant_id: grantId, revoked: true });
      return;
    }

    // hasEmail
    const email = args.flags.get("email");
    if (!email) {
      fail(
        "missing <addr> — usage: pane share <pane-id> --email <addr>",
        "invalid_args",
      );
    }
    const role = args.flags.get("role");
    if (role !== undefined && role !== "participant" && role !== "viewer") {
      fail(
        `invalid --role '${role}' — expected 'participant' or 'viewer'`,
        "invalid_args",
      );
    }
    const res = await client.createGrant(paneId!, {
      email: email!,
      ...(role ? { role: role as "participant" | "viewer" } : {}),
    });
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}
