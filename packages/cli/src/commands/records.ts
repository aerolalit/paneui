// `pane records` — CRUD + watch for per-pane mutable record collections
// (#297). Thin wrapper over the @paneui/core PaneClient + openStream APIs.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient, resolveConfig } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveJson } from "../input.js";
import { openStream, type RecordDeltaMessage } from "@paneui/core";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const recordsHelp = `pane records — CRUD + watch for per-pane record collections

A record is a row in a mutable per-pane collection (posts, comments,
reactions, etc.) declared by the template's recordSchema. The deep design is
at https://github.com/aerolalit/paneui/issues/287.

Usage:
  pane records <verb> [options]

Verbs:
  list <pane-id> <collection>
       [--since <seq>] [--limit <n>] [--include-tombstones]
  get  <pane-id> <collection> <record-key>
  upsert <pane-id> <collection>
       --data <path|json> [--key <record-key>]
  update <pane-id> <collection> <record-key>
       --data <path|json> [--if-match <version>]
  delete <pane-id> <collection> <record-key>
       [--if-match <version>] [--yes]
  delete-collection <pane-id> <collection>
       [--yes]
       Drop a WHOLE collection — all its records + the collection row.
       Owner-only. Collection names are immutable (no rename): to "rename",
       delete the old collection and write under the new name.
  watch  <pane-id>
       [--collection <name>]... [--since-seq <name>=<n>]...

Output (stdout, JSON-per-line for watch, single JSON for others).
Errors on stderr: {"error":{"code","message"}} with non-zero exit.`;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function runRecords(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];

  // `pane records --help` (top-level, no verb)
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(recordsHelp + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb — pane records <list|get|upsert|update|delete|delete-collection|watch>",
      "invalid_args",
    );
  }

  const sub: ParsedArgs = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    bools: args.bools,
    ...(args.danglingValueFlags !== undefined
      ? { danglingValueFlags: args.danglingValueFlags }
      : {}),
  };

  switch (verb) {
    case "list":
      return runList(sub);
    case "get":
      return runGet(sub);
    case "upsert":
      return runUpsert(sub);
    case "update":
      return runUpdate(sub);
    case "delete":
      return runDelete(sub);
    case "delete-collection":
      return runDeleteCollection(sub);
    case "watch":
      return runWatch(sub);
    default:
      fail(
        `unknown verb '${verb}' — pane records <list|get|upsert|update|delete|delete-collection|watch>`,
        "invalid_args",
      );
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["since", "limit", "url", "api-key"],
    ["include-tombstones", "help"],
    "pane records list",
  );
  const paneId = args.positionals[0];
  const collection = args.positionals[1];
  if (!paneId || !collection) {
    fail("usage: pane records list <pane-id> <collection>", "invalid_args");
  }
  const since = parseIntFlag(args, "since", 0);
  const limit = parseIntFlag(args, "limit", undefined, { min: 1, max: 200 });
  const includeTombstones = args.bools.has("include-tombstones");

  const client = makeClient(args);
  try {
    const page = await client.listRecords(paneId!, collection!, {
      since,
      ...(limit !== undefined ? { limit } : {}),
    });
    const records = includeTombstones
      ? page.records
      : page.records.filter((r) => r.deleted_at === null);
    printJson({
      records,
      next_since: page.next_since,
      has_more: page.has_more,
    });
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// get — client-side scan via listRecords (no dedicated route today)
// ---------------------------------------------------------------------------

async function runGet(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ["url", "api-key"], ["help"], "pane records get");
  const [paneId, collection, recordKey] = args.positionals;
  if (!paneId || !collection || !recordKey) {
    fail(
      "usage: pane records get <pane-id> <collection> <record-key>",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const row = await client.getRecord(paneId!, collection!, recordKey!);
    if (!row) {
      fail(
        `no record at key '${recordKey}' in collection '${collection}'`,
        "record_not_found",
      );
    }
    printJson({ record: row });
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// upsert — create-or-return-existing
// ---------------------------------------------------------------------------

async function runUpsert(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["data", "key", "url", "api-key"],
    ["help"],
    "pane records upsert",
  );
  const [paneId, collection] = args.positionals;
  if (!paneId || !collection) {
    fail(
      "usage: pane records upsert <pane-id> <collection> --data <path|json>",
      "invalid_args",
    );
  }
  const dataRaw = args.flags.get("data");
  if (dataRaw === undefined) {
    fail(
      "--data is required (path to JSON file, or inline JSON)",
      "invalid_args",
    );
  }
  const data = resolveJson(dataRaw!, "--data");
  const key = args.flags.get("key");

  const client = makeClient(args);
  try {
    const body: { record_key?: string; data: unknown } = { data };
    if (key !== undefined) body.record_key = key;
    const out = await client.upsertRecord(paneId!, collection!, body);
    printJson(out);
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// update — optimistic-lock mutate
// ---------------------------------------------------------------------------

async function runUpdate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["data", "if-match", "url", "api-key"],
    ["help"],
    "pane records update",
  );
  const [paneId, collection, recordKey] = args.positionals;
  if (!paneId || !collection || !recordKey) {
    fail(
      "usage: pane records update <pane-id> <collection> <record-key> --data <path|json>",
      "invalid_args",
    );
  }
  const dataRaw = args.flags.get("data");
  if (dataRaw === undefined) {
    fail(
      "--data is required (path to JSON file, or inline JSON)",
      "invalid_args",
    );
  }
  const data = resolveJson(dataRaw!, "--data");
  const ifMatch = parseIntFlag(args, "if-match", undefined, { min: 0 });

  const client = makeClient(args);
  try {
    const body: { data: unknown; if_match?: number } = { data };
    if (ifMatch !== undefined) body.if_match = ifMatch;
    const out = await client.updateRecord(
      paneId!,
      collection!,
      recordKey!,
      body,
    );
    printJson(out);
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// delete — soft-delete
// ---------------------------------------------------------------------------

async function runDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["if-match", "url", "api-key"],
    ["yes", "help"],
    "pane records delete",
  );
  const [paneId, collection, recordKey] = args.positionals;
  if (!paneId || !collection || !recordKey) {
    fail(
      "usage: pane records delete <pane-id> <collection> <record-key>",
      "invalid_args",
    );
  }
  const ifMatch = parseIntFlag(args, "if-match", undefined, { min: 0 });

  const client = makeClient(args);
  try {
    await client.deleteRecord(paneId!, collection!, recordKey!, {
      ...(ifMatch !== undefined ? { ifMatch } : {}),
    });
    printJson({ deleted: true, key: recordKey });
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// delete-collection — drop a whole collection (all rows + the collection row)
// ---------------------------------------------------------------------------

async function runDeleteCollection(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["url", "api-key"],
    ["yes", "help"],
    "pane records delete-collection",
  );
  const [paneId, collection] = args.positionals;
  if (!paneId || !collection) {
    fail(
      "usage: pane records delete-collection <pane-id> <collection>",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    await client.deleteRecordCollection(paneId!, collection!);
    printJson({ deleted: true, collection });
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// watch — stream record deltas as JSON-lines
// ---------------------------------------------------------------------------

async function runWatch(args: ParsedArgs): Promise<void> {
  // --collection is repeated-value; collected via danglingValueFlags + flags
  assertKnownFlags(
    args,
    ["collection", "since-seq", "url", "api-key"],
    ["help"],
    "pane records watch",
  );
  const [paneId] = args.positionals;
  if (!paneId) {
    fail("usage: pane records watch <pane-id>", "invalid_args");
  }

  // --collection a,b,c (single comma list) OR repeated --collection foo flags.
  // The shared argv parser uses a Map<string,string> for flags so a repeated
  // flag last-write-wins. To support repeats here would need a parser
  // extension; for now we accept a single comma list — the common case.
  const collectionsRaw = args.flags.get("collection");
  const subscribeRecords =
    collectionsRaw && collectionsRaw.length > 0 ? collectionsRaw : "*";

  // --since-seq is a single comma list "name=N,name=M" for the same reason.
  const sinceRaw = args.flags.get("since-seq");
  const sinceRecordSeq: Record<string, number> = {};
  if (sinceRaw) {
    for (const part of sinceRaw.split(",")) {
      const [name, vRaw] = part.split("=");
      if (!name || vRaw === undefined) {
        fail(
          "--since-seq must be a comma list of name=N pairs",
          "invalid_args",
        );
      }
      const n = Number(vRaw);
      if (!Number.isInteger(n) || n < 0) {
        fail(
          `--since-seq ${name}: value must be a non-negative integer`,
          "invalid_args",
        );
      }
      sinceRecordSeq[name!] = n;
    }
  }

  const cfg = resolveConfig(args);
  const handle = openStream(
    {
      wsBaseUrl: cfg.url.replace(/^http/, "ws"),
      paneId: paneId!,
      token: cfg.apiKey,
      subscribeRecords,
      sinceRecordSeq,
    },
    {
      onRecord: (msg: RecordDeltaMessage) => {
        process.stdout.write(JSON.stringify(msg) + "\n");
      },
      onRelayError: (err) => {
        process.stderr.write(JSON.stringify({ error: err }) + "\n");
      },
      onError: (err) => {
        process.stderr.write(
          JSON.stringify({
            error: { code: "ws_error", message: err.message },
          }) + "\n",
        );
      },
      onClose: () => {
        // Clean exit on close (e.g. SIGINT closed the socket). Emit nothing —
        // the JSON-line stream is the contract; a trailing summary would
        // confuse pipe readers.
      },
    },
  );

  // Hold the process open until SIGINT closes the stream.
  process.on("SIGINT", () => {
    handle.close();
    process.exit(0);
  });
  await new Promise<void>(() => {
    /* never resolves — SIGINT exits */
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIntFlag(
  args: ParsedArgs,
  name: string,
  defaultValue: number | undefined,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    fail(`--${name} must be an integer`, "invalid_args");
  }
  if (bounds.min !== undefined && n < bounds.min) {
    fail(`--${name} must be >= ${bounds.min}`, "invalid_args");
  }
  if (bounds.max !== undefined && n > bounds.max) {
    fail(`--${name} must be <= ${bounds.max}`, "invalid_args");
  }
  return n;
}
