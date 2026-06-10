// `pane template-records` — CRUD for template-level record collections.
//
// Owner-curated content scoped to a Template head, visible to every pane
// derived from any version of the template. Mirrors `pane records` (per-pane
// records) verb-for-verb; the only difference is the resource path goes
// `/templates/:id/...` instead of `/panes/:id/...`.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveJson } from "../input.js";

export const templateRecordsHelp = `pane template-records — CRUD for template-level record collections

Template records are owner-curated shared content anchored to a Template head.
Every pane derived from any version of the template sees the same rows.
Declared via the template version's \`template_record_schema\`; writes are
owner-only (the template's agent + same-human-claimed agents). Page-side
reads use the in-iframe \`pane.template.records.*\` bridge (no HTTP).

Usage:
  pane template-records <verb> [options]

Verbs:
  list <template-id|slug> <collection>
       [--since <seq>] [--limit <n>] [--include-tombstones]
  get  <template-id|slug> <collection> <record-key>
  upsert <template-id|slug> <collection>
       --data <path|json> [--key <record-key>]
  update <template-id|slug> <collection> <record-key>
       --data <path|json> [--if-match <version>]
  delete <template-id|slug> <collection> <record-key>
       [--if-match <version>] [--yes]
  delete-collection <template-id|slug> <collection>
       [--yes]
       Drop a WHOLE collection — all its records + the collection row.
       Owner-only. Collection names are immutable (no rename): to "rename",
       delete the old collection and write under the new name.

Output (stdout): single JSON object per command.
Errors on stderr: {"error":{"code","message"}} with non-zero exit.`;

export async function runTemplateRecords(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];

  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(templateRecordsHelp + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb — pane template-records <list|get|upsert|update|delete|delete-collection>",
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
    default:
      fail(
        `unknown verb '${verb}' — pane template-records <list|get|upsert|update|delete|delete-collection>`,
        "invalid_args",
      );
  }
}

async function runList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["since", "limit", "url", "api-key"],
    ["include-tombstones", "help"],
    "pane template-records list",
  );
  const templateId = args.positionals[0];
  const collection = args.positionals[1];
  if (!templateId || !collection) {
    fail(
      "usage: pane template-records list <template-id|slug> <collection>",
      "invalid_args",
    );
  }
  const since = parseIntFlag(args, "since", 0);
  const limit = parseIntFlag(args, "limit", undefined, { min: 1, max: 200 });
  const includeTombstones = args.bools.has("include-tombstones");

  const client = makeClient(args);
  try {
    const page = await client.listTemplateRecords(templateId!, collection!, {
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

async function runGet(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["url", "api-key"],
    ["help"],
    "pane template-records get",
  );
  const [templateId, collection, recordKey] = args.positionals;
  if (!templateId || !collection || !recordKey) {
    fail(
      "usage: pane template-records get <template-id|slug> <collection> <record-key>",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const row = await client.getTemplateRecord(
      templateId!,
      collection!,
      recordKey!,
    );
    if (!row) {
      fail(
        `no template record at key '${recordKey}' in collection '${collection}'`,
        "template_record_not_found",
      );
    }
    printJson({ record: row });
  } catch (e) {
    failFromError(e);
  }
}

async function runUpsert(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["data", "key", "url", "api-key"],
    ["help"],
    "pane template-records upsert",
  );
  const [templateId, collection] = args.positionals;
  if (!templateId || !collection) {
    fail(
      "usage: pane template-records upsert <template-id|slug> <collection> --data <path|json>",
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
    const out = await client.upsertTemplateRecord(
      templateId!,
      collection!,
      body,
    );
    printJson(out);
  } catch (e) {
    failFromError(e);
  }
}

async function runUpdate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["data", "if-match", "url", "api-key"],
    ["help"],
    "pane template-records update",
  );
  const [templateId, collection, recordKey] = args.positionals;
  if (!templateId || !collection || !recordKey) {
    fail(
      "usage: pane template-records update <template-id|slug> <collection> <record-key> --data <path|json>",
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
    const out = await client.updateTemplateRecord(
      templateId!,
      collection!,
      recordKey!,
      body,
    );
    printJson(out);
  } catch (e) {
    failFromError(e);
  }
}

async function runDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["if-match", "url", "api-key"],
    ["yes", "help"],
    "pane template-records delete",
  );
  const [templateId, collection, recordKey] = args.positionals;
  if (!templateId || !collection || !recordKey) {
    fail(
      "usage: pane template-records delete <template-id|slug> <collection> <record-key>",
      "invalid_args",
    );
  }
  const ifMatch = parseIntFlag(args, "if-match", undefined, { min: 0 });

  const client = makeClient(args);
  try {
    await client.deleteTemplateRecord(templateId!, collection!, recordKey!, {
      ...(ifMatch !== undefined ? { ifMatch } : {}),
    });
    printJson({ deleted: true, key: recordKey });
  } catch (e) {
    failFromError(e);
  }
}

async function runDeleteCollection(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    ["url", "api-key"],
    ["yes", "help"],
    "pane template-records delete-collection",
  );
  const [templateId, collection] = args.positionals;
  if (!templateId || !collection) {
    fail(
      "usage: pane template-records delete-collection <template-id|slug> <collection>",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    await client.deleteTemplateRecordCollection(templateId!, collection!);
    printJson({ deleted: true, collection });
  } catch (e) {
    failFromError(e);
  }
}

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
