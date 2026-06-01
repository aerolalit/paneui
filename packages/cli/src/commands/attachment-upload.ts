// `pane attachment upload` — POST /v1/attachments (multipart), three scopes.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

const KNOWN_FLAGS = [
  "file",
  "scope",
  "pane-id",
  "template-id",
  "filename",
  "mime",
];
const KNOWN_BOOLS: string[] = [];

export const blobUploadHelp = `pane attachment upload — upload a local file as a attachment

Usage:
  pane attachment upload --file <path> [options]

Required:
  --file <path>          Local file to upload.

Scope (default: agent):
  --scope <s>            "agent" | "pane" | "template".
  --pane-id <id>      Required when --scope=pane.
  --template-id <id>     Required when --scope=template.

Optional:
  --filename <name>      Display filename (otherwise basename of --file).
  --mime <type>          Declared Content-Type. The relay sniffs the bytes
                         regardless — this is advisory.
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output (stdout, JSON):
  AttachmentRef — { attachment_id, scope, mime, size, sha256, ... }`;

export async function runBlobUpload(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane attachment upload");

  const filePath = args.flags.get("file");
  if (!filePath) {
    fail(
      "missing --file <path> — 'pane attachment upload' requires a local file to upload",
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
  if (scopeRaw !== "agent" && scopeRaw !== "pane" && scopeRaw !== "template") {
    fail(
      `unknown --scope '${scopeRaw}' — expected one of: agent, pane, template`,
      "invalid_args",
    );
  }
  const scope = scopeRaw as "agent" | "pane" | "template";
  if (scope === "pane" && !args.flags.get("pane-id")) {
    fail("--scope=pane requires --pane-id <id>", "invalid_args");
  }
  if (scope === "template" && !args.flags.get("template-id")) {
    fail("--scope=template requires --template-id <id>", "invalid_args");
  }

  const client = makeClient(args);
  try {
    const ref = await client.uploadBlob(bytes, {
      scope,
      paneId: args.flags.get("pane-id"),
      templateId: args.flags.get("template-id"),
      filename: args.flags.get("filename") ?? basename(filePath),
      mime: args.flags.get("mime"),
    });
    printJson(ref);
  } catch (e) {
    failFromError(e);
  }
}
