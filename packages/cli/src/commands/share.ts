// `pane share <pane-id>` — manage identity sharing on a pane.
//
//   pane share <pane-id> --email <addr> [--role participant|viewer]
//       Invite a human by email (upsert). Role defaults to participant
//       (read + emit); viewer is read-only.
//   pane share <pane-id> --mode <invite-only|link|public>
//       Set the pane-id (/p/<pane-id>) access mode. Convenience aliases:
//       --public (= public), --link (= link), --invite-only (= invite_only).
//       Token (/s/<token>) links are independent and keep working in every
//       mode.
//   pane share <pane-id> --list
//       Show the pane's access_mode + every grant.
//   pane share <pane-id> --revoke <grant-id>
//       Remove one grant (idempotent).
//
// One verb per invocation. Output is machine-readable JSON on stdout; errors
// are `{"error":{"code","message"}}` on stderr with a non-zero exit.

import type { AccessMode } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

// Value-flags this command accepts (in addition to the global --url/--api-key/
// --profile). Boolean flags (--public/--link/--invite-only/--list) are
// registered in index.ts's BOOLEAN_FLAGS so the parser doesn't swallow the
// next token.
const VALUE_FLAGS = ["email", "role", "revoke", "mode"];
const BOOL_FLAGS = ["public", "link", "invite-only", "list"];

// Map a --mode value (or one of the convenience boolean aliases) to the wire
// AccessMode. Accepts both hyphenated ("invite-only") and underscore
// ("invite_only") spellings for --mode.
function parseAccessMode(value: string): AccessMode | null {
  switch (value) {
    case "invite_only":
    case "invite-only":
      return "invite_only";
    case "link":
      return "link";
    case "public":
      return "public";
    default:
      return null;
  }
}

export const shareHelp = `pane share — manage identity sharing on a pane

A pane has two layered share mechanisms on top of participant tokens:
  - access mode: governs the pane-id (/p/<pane-id>) path. One of:
      invite-only  only invited people (after login) can open it.
      link         anyone with the /p URL opens it read-only, no login
                   (the default; not discoverable).
      public       anyone opens it read-only, no login (may be listed later).
  - invitation: specific humans (by email) get a grant. A 'participant'
                grant can read AND emit page events; a 'viewer' grant is
                read-only. A pending invite binds to the human on their
                first magic-link login.

Token (/s/<token>) links are independent of the access mode and keep working
in every mode until explicitly revoked.

Usage:
  pane share <pane-id> --email <addr> [--role participant|viewer]
  pane share <pane-id> --mode <invite-only|link|public>
  pane share <pane-id> --public | --link | --invite-only
  pane share <pane-id> --list
  pane share <pane-id> --revoke <grant-id>

Verbs (exactly one per call):
  --email <addr>          Invite a human by email (upsert). --role defaults
                          to 'participant'. Re-inviting the same address
                          updates the role in place. Returns the grant
                          { id, human_id, invite_email, role, accepted_at }.
  --mode <mode>           Set the /p access mode (invite-only|link|public).
                          Returns { pane_id, access_mode }.
  --public                Alias for --mode public.
  --link                  Alias for --mode link.
  --invite-only           Alias for --mode invite-only.
  --list                  Show { pane_id, access_mode, items: [grant...] }.
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
      "missing <pane-id> — usage: pane share <pane-id> --email <addr> | --mode <invite-only|link|public> | --list | --revoke <grant-id>",
      "invalid_args",
    );
  }

  // Determine which verb was requested; reject ambiguous combinations so the
  // caller's intent is never guessed. The three access-mode aliases
  // (--public / --link / --invite-only) and the explicit --mode all collapse
  // to the single "set access mode" verb.
  const hasEmail = args.flags.has("email");
  const hasMode = args.flags.has("mode");
  const hasPublic = args.bools.has("public");
  const hasLink = args.bools.has("link");
  const hasInviteOnly = args.bools.has("invite-only");
  const hasList = args.bools.has("list");
  const hasRevoke = args.flags.has("revoke");

  const modeAliasCount =
    (hasMode ? 1 : 0) +
    (hasPublic ? 1 : 0) +
    (hasLink ? 1 : 0) +
    (hasInviteOnly ? 1 : 0);
  const hasModeVerb = modeAliasCount > 0;

  const verbCount =
    (hasEmail ? 1 : 0) +
    (hasModeVerb ? 1 : 0) +
    (hasList ? 1 : 0) +
    (hasRevoke ? 1 : 0);

  if (verbCount === 0) {
    fail(
      "missing verb — pass exactly one of --email <addr>, --mode <invite-only|link|public> (or --public/--link/--invite-only), --list, --revoke <grant-id>",
      "invalid_args",
    );
  }
  if (verbCount > 1 || modeAliasCount > 1) {
    fail(
      "ambiguous — pass exactly one of --email, --mode/--public/--link/--invite-only, --list, --revoke",
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

    if (hasModeVerb) {
      // Resolve the access mode from --mode or one of the boolean aliases.
      let mode: AccessMode | null;
      if (hasMode) {
        const raw = args.flags.get("mode");
        if (!raw) {
          fail(
            "missing <mode> — usage: pane share <pane-id> --mode <invite-only|link|public>",
            "invalid_args",
          );
        }
        mode = parseAccessMode(raw!);
        if (!mode) {
          fail(
            `invalid --mode '${raw}' — expected 'invite-only', 'link', or 'public'`,
            "invalid_args",
          );
        }
      } else if (hasPublic) {
        mode = "public";
      } else if (hasLink) {
        mode = "link";
      } else {
        mode = "invite_only";
      }
      const res = await client.setPaneVisibility(paneId!, mode!);
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
