// `pane blob` — manage binary attachments (blobs) on the relay.
//
// Five subcommands cover the v0.1.0 blob surface:
//
//   pane blob upload       — POST /v1/blobs (multipart), three scopes
//   pane blob delete       — DELETE /v1/blobs/:id, soft-delete idempotent
//   pane blob show         — HEAD /v1/blobs/:id metadata
//   pane blob mint-token   — POST /v1/blobs/:id/tokens (capability URL)
//   pane blob revoke-token — DELETE /v1/blobs/:id/tokens/:token_id
//
// Download is `pane blob download <id> --out <file>` (streams to stdout
// by default, but binary on stdout is rarely useful).
//
// The CLI is a thin wrapper around @paneui/core's PaneClient blob methods.
// Authz: every operation is on blobs owned by the calling agent.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export const blobHelp = `pane blob — manage blobs (binary attachments) on the relay

A blob is a typed binary file (image, PDF, etc.) the agent has uploaded to
the relay. Blobs are scoped:

  agent     — reusable across the agent's sessions (default)
  session   — bound to one session; deleted with it
  artifact  — bound to a reusable artifact; deleted with it

Pages reference blobs by id (the relay's schema validates the id with
\`format: pane-blob-id\`). For a participant-facing URL that bypasses the
agent's API key, mint a token with 'pane blob mint-token'.

Usage:
  pane blob <subcommand> [options]

Subcommands:
  upload         Upload a local file. Required: --file. Optional: --scope,
                 --session-id, --artifact-id, --filename, --mime. Prints
                 { blob_id, scope, mime, size, sha256, ... }.

  download       Download a blob by id. Use --out <path> to write a file
                 (default: writes to stdout — useful for piping).

  show           Print a blob's metadata (HEAD-based — doesn't download
                 the bytes).

  delete         Remove a blob. Idempotent.

  mint-token     Mint a /b/<token> capability URL. Options: --ttl <seconds>
                 (defaults by scope: 30d artifact / session TTL / 24h agent;
                 caller can only shorten), --once (token self-deletes on
                 first successful GET). Prints { token, url, expires_at }.

  revoke-token   Revoke a previously-minted token by id. Idempotent.

Options:
  --file <path>          (upload) local file path; required
  --scope <s>            (upload) "agent" | "session" | "artifact"; default "agent"
  --session-id <id>      (upload) required when --scope=session
  --artifact-id <id>     (upload) required when --scope=artifact
  --filename <name>      (upload) display name; otherwise basename of --file
  --mime <type>          (upload) declared Content-Type; relay sniffs anyway
  --out <path>           (download) write bytes to <path> instead of stdout
  --ttl <seconds>        (mint-token) per-token TTL; clamped by scope default
  --once                 (mint-token) token self-deletes on first GET
  --url <url>            Relay base URL (overrides PANE_URL)
  --api-key <key>        Agent API key (overrides PANE_API_KEY)
  -h, --help             Show this help

Examples:
  pane blob upload --file ./chart.png
  pane blob upload --file ./hero.jpg --scope session --session-id ses_xxx
  pane blob upload --file ./icon.svg --scope artifact --artifact-id <id>
  pane blob mint-token <blob_id> --once
  pane blob download <blob_id> --out ./out.png
  pane blob delete <blob_id>

Output: stdout is machine-readable JSON. Errors go to stderr as
{"error":{"code","message"}} with a non-zero exit.`;

async function runBlobUpload(args: ParsedArgs): Promise<void> {
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

async function runBlobDownload(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[1];
  if (!blobId) {
    fail("missing <blob_id> — 'pane blob download <blob_id>'", "invalid_args");
  }
  const out = args.flags.get("out");

  const client = makeClient(args);
  try {
    const buf = await client.downloadBlob(blobId);
    if (out) {
      writeFileSync(out, Buffer.from(buf));
      printJson({ blob_id: blobId, written: out, bytes: buf.byteLength });
    } else {
      // Binary to stdout — useful for piping into another tool.
      process.stdout.write(Buffer.from(buf));
    }
  } catch (e) {
    failFromError(e);
  }
}

async function runBlobShow(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[1];
  if (!blobId) {
    fail("missing <blob_id> — 'pane blob show <blob_id>'", "invalid_args");
  }
  const client = makeClient(args);
  try {
    const ref = await client.getBlob(blobId);
    printJson(ref);
  } catch (e) {
    failFromError(e);
  }
}

async function runBlobDelete(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[1];
  if (!blobId) {
    fail("missing <blob_id> — 'pane blob delete <blob_id>'", "invalid_args");
  }
  const client = makeClient(args);
  try {
    const r = await client.deleteBlob(blobId);
    printJson({ blob_id: blobId, ...r });
  } catch (e) {
    failFromError(e);
  }
}

async function runBlobMintToken(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[1];
  if (!blobId) {
    fail(
      "missing <blob_id> — 'pane blob mint-token <blob_id>'",
      "invalid_args",
    );
  }
  const ttlRaw = args.flags.get("ttl");
  const ttl = ttlRaw === undefined ? undefined : Number(ttlRaw);
  if (ttlRaw !== undefined && (!Number.isInteger(ttl) || ttl! <= 0)) {
    fail("--ttl must be a positive integer (seconds)", "invalid_args");
  }
  const client = makeClient(args);
  try {
    const r = await client.mintBlobToken(blobId, {
      ttlSeconds: ttl,
      once: args.bools.has("once"),
    });
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}

async function runBlobRevokeToken(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[1];
  const tokenId = args.positionals[2];
  if (!blobId || !tokenId) {
    fail(
      "missing arguments — 'pane blob revoke-token <blob_id> <token_id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const r = await client.revokeBlobToken(blobId, tokenId);
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}

export async function runBlob(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "upload":
      await runBlobUpload(args);
      break;
    case "download":
      await runBlobDownload(args);
      break;
    case "show":
      await runBlobShow(args);
      break;
    case "delete":
      await runBlobDelete(args);
      break;
    case "mint-token":
      await runBlobMintToken(args);
      break;
    case "revoke-token":
      await runBlobRevokeToken(args);
      break;
    case undefined:
      fail(
        "missing subcommand — usage: pane blob <upload|download|show|delete|mint-token|revoke-token> (run 'pane blob --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown blob subcommand '${sub}' — expected upload|download|show|delete|mint-token|revoke-token (run 'pane blob --help')`,
        "invalid_args",
      );
  }
}
