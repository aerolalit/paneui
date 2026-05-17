// `pane create` — create a session via POST /v1/sessions.

import { createSessionSchema, type CreateSessionRequest } from "@pane/core";
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
  let source: string;
  try {
    source =
      artifactType === "html-ref" ? artifactVal! : resolveText(artifactVal!);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "invalid_args");
  }

  let schema: unknown;
  try {
    schema = resolveJson(schemaVal!, "--schema");
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "invalid_args");
  }

  // Assemble a candidate request object, then validate the whole thing with
  // the shared Zod schema (single source of truth, matches what the relay
  // expects). Per-field number parsing still happens here so we can give a
  // flag-specific message; the schema then enforces shape and bounds.
  const candidate: Record<string, unknown> = {
    artifact: { type: artifactType, source },
    schema,
  };

  const ttlRaw = args.flags.get("ttl");
  if (ttlRaw !== undefined) {
    const ttl = Number(ttlRaw);
    if (!Number.isFinite(ttl)) fail("--ttl must be a number", "invalid_args");
    candidate["ttl"] = ttl;
  }

  const partRaw = args.flags.get("participants");
  if (partRaw !== undefined) {
    const humans = Number(partRaw);
    if (!Number.isFinite(humans))
      fail("--participants must be a number", "invalid_args");
    candidate["participants"] = { humans };
  }

  const metaRaw = args.flags.get("metadata");
  if (metaRaw !== undefined) {
    try {
      candidate["metadata"] = resolveJson(metaRaw, "--metadata");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }
  }

  const cbRaw = args.flags.get("callback");
  if (cbRaw !== undefined) {
    try {
      candidate["callback"] = resolveJson(cbRaw, "--callback");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }
  }

  const parsed = createSessionSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? issue.path.join(".") : "request";
    fail(
      `invalid create request: ${where}: ${issue ? issue.message : "validation failed"}`,
      "invalid_args",
      parsed.error.flatten(),
    );
  }

  const req: CreateSessionRequest = parsed.data;

  const client = makeClient(args);
  try {
    const res = await client.createSession(req);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}
