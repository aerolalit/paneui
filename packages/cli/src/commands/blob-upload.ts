// `pane blob upload` — POST /v1/blobs (multipart), three scopes.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export const blobUploadHelp = `pane blob upload — upload a local file as a blob

Usage:
  pane blob upload --file <path> [options]

Required:
  --file <path>          Local file to upload.

Scope (default: agent):
  --scope <s>            "agent" | "session" | "artifact".
  --session-id <id>      Required when --scope=session.
  --artifact-id <id>     Required when --scope=artifact.

Optional:
  --filename <name>      Display filename (otherwise basename of --file).
  --mime <type>          Declared Content-Type. The relay sniffs the bytes
                         regardless — this is advisory.
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output (stdout, JSON):
  BlobRef — { blob_id, scope, mime, size, sha256, ... }`;

export async function runBlobUpload(args: ParsedArgs): Promise<void> {
  const filePath = args.flags.get("file");
  if (!filePath) {
    fail(
      "missing --file <path> — 'pane blob upload' requires a local file to upload",
      "invalid_args",
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (e) {
    fail(
      `failed to read --file '${filePath}': ${e instanceof Error ? e.message : String(e)}`,
      "invalid_args",
    );
  }
  const scopeRaw = args.flags.get("scope") ?? "agent";
  if (
    scopeRaw !== "agent" &&
    scopeRaw !== "session" &&
    scopeRaw !== "artifact"
  ) {
    fail(
      `unknown --scope '${scopeRaw}' — expected one of: agent, session, artifact`,
      "invalid_args",
    );
  }
  const scope = scopeRaw as "agent" | "session" | "artifact";
  if (scope === "session" && !args.flags.get("session-id")) {
    fail("--scope=session requires --session-id <id>", "invalid_args");
  }
  if (scope === "artifact" && !args.flags.get("artifact-id")) {
    fail("--scope=artifact requires --artifact-id <id>", "invalid_args");
  }

  const client = makeClient(args);
  try {
    const ref = await client.uploadBlob(bytes, {
      scope,
      sessionId: args.flags.get("session-id"),
      artifactId: args.flags.get("artifact-id"),
      filename: args.flags.get("filename") ?? basename(filePath),
      mime: args.flags.get("mime"),
    });
    printJson(ref);
  } catch (e) {
    failFromError(e);
  }
}
