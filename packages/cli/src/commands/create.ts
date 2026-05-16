// `pane create` — create a session via POST /v1/sessions.

import type { CreateSessionRequest } from "@pane/core";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson, resolveText } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

export const createHelp = `pane create — create a Pane session

Usage:
  pane create --artifact <path|inline> --schema <path|json> [options]

Required:
  --artifact <v>      HTML artifact. Either a file path / URL, or inline HTML.
                      Combine with --artifact-type to control interpretation.
  --schema <v>        Per-session event schema. A path to a .json file, or
                      inline JSON.

Options:
  --artifact-type <t> "html-inline" (default) or "html-ref". With "html-ref"
                      the --artifact value is treated as a URL.
  --ttl <seconds>     Session time-to-live in seconds.
  --participants <n>  Number of human participants (default 1).
  --metadata <path|json>  Arbitrary metadata object (file path or inline JSON).
  --callback <path|json>  Webhook callback config: { url, events[], secret }.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  --json              Output JSON (default).
  -h, --help          Show this help.

Output (stdout, JSON):
  { session_id, urls, tokens, expires_at }

Deliver urls.humans to the human(s); keep tokens.agent for the WS stream.`;

export async function runCreate(args: ParsedArgs): Promise<void> {
  const artifactVal = args.flags.get("artifact");
  const schemaVal = args.flags.get("schema");
  if (!artifactVal) fail("missing --artifact", "invalid_args");
  if (!schemaVal) fail("missing --schema", "invalid_args");

  const artifactType = (args.flags.get("artifact-type") ?? "html-inline") as
    | "html-inline"
    | "html-ref";
  if (artifactType !== "html-inline" && artifactType !== "html-ref") {
    fail("--artifact-type must be 'html-inline' or 'html-ref'", "invalid_args");
  }

  // html-ref: the value is a URL, used verbatim. html-inline: file or literal.
  const source = artifactType === "html-ref" ? artifactVal! : resolveText(artifactVal!);

  let schema: unknown;
  try {
    schema = resolveJson(schemaVal!, "--schema");
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "invalid_args");
  }

  const req: CreateSessionRequest = {
    artifact: { type: artifactType, source },
    schema,
  };

  const ttlRaw = args.flags.get("ttl");
  if (ttlRaw !== undefined) {
    const ttl = Number(ttlRaw);
    if (!Number.isInteger(ttl) || ttl <= 0) fail("--ttl must be a positive integer", "invalid_args");
    req.ttl = ttl;
  }

  const partRaw = args.flags.get("participants");
  if (partRaw !== undefined) {
    const humans = Number(partRaw);
    if (!Number.isInteger(humans) || humans <= 0) {
      fail("--participants must be a positive integer", "invalid_args");
    }
    req.participants = { humans };
  }

  const metaRaw = args.flags.get("metadata");
  if (metaRaw !== undefined) {
    try {
      req.metadata = resolveJson(metaRaw, "--metadata") as Record<string, unknown>;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }
  }

  const cbRaw = args.flags.get("callback");
  if (cbRaw !== undefined) {
    try {
      req.callback = resolveJson(cbRaw, "--callback") as CreateSessionRequest["callback"];
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }
  }

  const client = makeClient(args);
  try {
    const res = await client.createSession(req);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}
