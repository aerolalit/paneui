// template-records.ts — the template-level record-collection writer.
//
// Peer to core/records.ts. Template records are owner-curated shared content
// anchored to a Template head: every pane derived from any version of the
// template sees the same rows. Use cases: a publisher's list of suggested
// prompts, a featured-links list shared across every instance, a content
// catalog that updates without re-publishing the template.
//
// The relation between the two:
//
//   per-pane records (core/records.ts)        template records (this file)
//   --------------------------------------    -------------------------------
//   record_schema on TemplateVersion          template_record_schema on TemplateVersion
//   collections rooted at a Pane              collections rooted at a Template (head)
//   any participant (agent / page) may        owner only (the template's agent +
//     write per the schema's allowlist          same-human-claimed agents). page
//                                               side has read-only access through
//                                               the in-iframe bridge.
//   broadcast over the per-pane WS            broadcast over each derived pane's
//                                               WS (lands in PR B)
//
// Public surface (stable):
//   writeTemplateRecord  — POST: create-or-return-existing
//   updateTemplateRecord — PATCH: optimistic-lock mutate
//   deleteTemplateRecord — DELETE: soft-delete with optional optimistic lock
//   listTemplateRecords  — GET: cursor-paginated list with tombstones
//   sweepTemplateRecordTombstones — sweeper pass (called from sweeper loop)
//
// Schema validation reuses the per-write Ajv compiler from core/records.ts;
// the wire shape and column layout are identical to per-pane records so the
// per-write validator factory is shared.

import { createRequire } from "node:module";
import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  Template,
  TemplateRecord,
  TemplateRecordCollection,
  TemplateVersion,
} from "@prisma/client";
import type { ValidateFunction } from "ajv";
import { ApiError, errors } from "../http/errors.js";
import { publishToTemplate } from "../http/broadcast.js";
import { log } from "../log.js";
import type { Author, AuthorKind } from "../types.js";
import type { Config } from "../config.js";
import {
  templateRecordDelete as makeTemplateRecordDelete,
  templateRecordUpsert as makeTemplateRecordUpsert,
} from "../ws/messages.js";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

// A template-head row with its latest version eagerly loaded — every caller
// passes this shape because the template_record_schema lives on
// templateVersion.templateRecordSchema.
export type TemplateWithSchema = Template & {
  latestVersionRow: TemplateVersion;
};

// Wire shape — separate from SerializedRecord (per-pane) so the response
// envelopes don't accidentally collapse. Same field set, different `kind`
// at the message layer (handled in PR B).
export interface SerializedTemplateRecord {
  id: string;
  collection: string;
  key: string;
  data: unknown;
  version: number;
  seq: number;
  author: { kind: AuthorKind; id: string };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DeletedTemplateRecordRef {
  id: string;
  key: string;
  seq: number;
  deleted_at: string;
}

export interface WriteTemplateRecordDeps {
  prisma: PrismaClient;
  // Reuses MAX_RECORD_DATA_BYTES / MAX_RECORDS_PER_COLLECTION for parity
  // with per-pane records; no separate config knobs in PR A.
  config?: Pick<Config, "MAX_RECORD_DATA_BYTES" | "MAX_RECORDS_PER_COLLECTION">;
}

const DEFAULT_MAX_RECORD_DATA_BYTES = 65_536;
const DEFAULT_MAX_RECORDS_PER_COLLECTION = 50_000;

export interface WriteTemplateRecordInput {
  collectionName: string;
  recordKey?: string;
  data: unknown;
}

export interface WriteTemplateRecordResult {
  record: SerializedTemplateRecord;
  /** True when the row already existed at the supplied key. */
  deduped: boolean;
}

export interface UpdateTemplateRecordInput {
  collectionName: string;
  recordKey: string;
  data: unknown;
  ifMatch?: number;
}

export interface UpdateTemplateRecordResult {
  record: SerializedTemplateRecord;
}

export interface DeleteTemplateRecordInput {
  collectionName: string;
  recordKey: string;
  ifMatch?: number;
}

// -------------------------------------------------------------------------
// templateRecordSchema resolution
// -------------------------------------------------------------------------

interface CollectionEntry {
  rowSchema: object;
}

// Pull templateRecordSchema off the template's latest version and resolve the
// named collection. 404 if undeclared, 400 if the version declares no
// template_record_schema at all (or it's malformed past the shape validator).
function resolveCollection(
  template: TemplateWithSchema,
  collectionName: string,
): CollectionEntry {
  const doc = template.latestVersionRow.templateRecordSchema as Record<
    string,
    unknown
  > | null;
  if (!doc || typeof doc !== "object") {
    throw templateRecordCollectionNotFound(
      collectionName,
      "template declares no template-level record collections (template_record_schema is null)",
    );
  }
  const xpc = doc["x-pane-collections"] as Record<string, unknown> | undefined;
  if (!xpc || typeof xpc !== "object") {
    throw templateRecordCollectionNotFound(
      collectionName,
      "template declares no template-level record collections",
    );
  }
  const entry = xpc[collectionName] as Record<string, unknown> | undefined;
  if (!entry) {
    throw templateRecordCollectionNotFound(
      collectionName,
      `collection '${collectionName}' is not declared in this template's template_record_schema`,
    );
  }
  const schemaField = entry["schema"] as { $ref?: string } | undefined;
  const refRaw = schemaField?.$ref;
  if (typeof refRaw !== "string") {
    throw errors.invalidRequest(
      `collection '${collectionName}' has malformed schema (missing $ref)`,
    );
  }
  const refMatch = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(refRaw);
  const defs = doc["$defs"] as Record<string, unknown> | undefined;
  const defName = refMatch?.[1];
  const rowSchema = defName ? defs?.[defName] : undefined;
  if (!rowSchema || typeof rowSchema !== "object" || Array.isArray(rowSchema)) {
    throw errors.invalidRequest(
      `collection '${collectionName}' has unresolvable schema $ref '${refRaw}'`,
    );
  }
  return { rowSchema: rowSchema as object };
}

// -------------------------------------------------------------------------
// Per-write Ajv compiler — separate cache from per-pane records so a hot
// pane (lots of per-pane writes) can't evict a hot template (lots of
// template-record writes), and vice versa. Same structure: LRU on a
// (templateId, schemaVersion) key, inner map keyed by collection name.
// -------------------------------------------------------------------------

const require = createRequire(import.meta.url);

const Ajv2020Ctor: new (opts?: object) => {
  compile: (schema: object) => ValidateFunction;
  addFormat: (
    name: string,
    fmt:
      | { type: "string"; validate: (s: string) => boolean }
      | ((s: string) => boolean),
  ) => unknown;
} = require("ajv/dist/2020");

const ajv2020 = new Ajv2020Ctor({
  strict: false,
  allErrors: true,
  removeAdditional: false,
});

ajv2020.addFormat("pane-attachment-id", {
  type: "string",
  validate: (s: string): boolean =>
    typeof s === "string" && /^c[a-z0-9]{20,40}$/.test(s),
});

const CACHE_MAX = 10_000;
const cache = new Map<string, Map<string, ValidateFunction>>();
const cacheKey = (templateId: string, schemaVersion: number): string =>
  `${templateId}:${schemaVersion}`;

function getCompiler(
  templateId: string,
  schemaVersion: number,
  collectionName: string,
  rowSchema: object,
): ValidateFunction {
  const k = cacheKey(templateId, schemaVersion);
  let perTemplate = cache.get(k);
  if (perTemplate) {
    cache.delete(k);
    cache.set(k, perTemplate);
    const hit = perTemplate.get(collectionName);
    if (hit) return hit;
  } else {
    perTemplate = new Map<string, ValidateFunction>();
    cache.set(k, perTemplate);
    while (cache.size > CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey === undefined) break;
      cache.delete(firstKey);
    }
  }
  const compiled = ajv2020.compile(rowSchema);
  perTemplate.set(collectionName, compiled);
  return compiled;
}

/** Drop a template's compiled-validator entries. */
export function invalidateTemplateRecordSchemaCache(templateId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${templateId}:`)) cache.delete(k);
  }
}

export function validateTemplateRecord(args: {
  templateId: string;
  schemaVersion: number;
  collectionName: string;
  rowSchema: object;
  data: unknown;
}): void {
  const validate = getCompiler(
    args.templateId,
    args.schemaVersion,
    args.collectionName,
    args.rowSchema,
  );
  if (!validate(args.data)) {
    throw errors.schemaViolation(
      "template_record_schema_violation",
      validate.errors,
      `template record data does not validate against the row schema for collection '${args.collectionName}'`,
    );
  }
}

// Test-only handle, mirroring the per-pane records cache introspection API.
export const __templateRecordSchemaCacheInternals = {
  size: (): number => cache.size,
  has: (templateId: string, schemaVersion: number): boolean =>
    cache.has(cacheKey(templateId, schemaVersion)),
  hasCollection: (
    templateId: string,
    schemaVersion: number,
    collectionName: string,
  ): boolean =>
    cache.get(cacheKey(templateId, schemaVersion))?.has(collectionName) ??
    false,
  clear: (): void => {
    cache.clear();
  },
  max: CACHE_MAX,
};

// -------------------------------------------------------------------------
// Serialization
// -------------------------------------------------------------------------

export function serializeTemplateRecord(
  row: TemplateRecord,
  collectionName: string,
): SerializedTemplateRecord {
  return {
    id: row.id,
    collection: collectionName,
    key: row.recordKey,
    data: row.data,
    version: row.version,
    seq: row.seq,
    author: { kind: row.authorKind as AuthorKind, id: row.authorId },
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

// -------------------------------------------------------------------------
// Read path
// -------------------------------------------------------------------------

export interface ListTemplateRecordsResult {
  records: SerializedTemplateRecord[];
  next_since: number;
  has_more: boolean;
}

export async function listTemplateRecords(
  prisma: PrismaClient,
  template: TemplateWithSchema,
  collectionName: string,
  opts: { since: number; limit: number },
): Promise<ListTemplateRecordsResult> {
  resolveCollection(template, collectionName); // 404s if undeclared

  const collection = await prisma.templateRecordCollection.findUnique({
    where: {
      templateId_name: { templateId: template.id, name: collectionName },
    },
  });
  if (!collection) {
    return { records: [], next_since: opts.since, has_more: false };
  }

  const rows = await prisma.templateRecord.findMany({
    where: { collectionId: collection.id, seq: { gt: opts.since } },
    orderBy: { seq: "asc" },
    take: opts.limit + 1,
  });
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextSince = page.length > 0 ? page[page.length - 1]!.seq : opts.since;
  return {
    records: page.map((r) => serializeTemplateRecord(r, collectionName)),
    next_since: nextSince,
    has_more: hasMore,
  };
}

// -------------------------------------------------------------------------
// Write path (POST) — create-or-return-existing
// -------------------------------------------------------------------------

export async function writeTemplateRecord(
  deps: WriteTemplateRecordDeps,
  template: TemplateWithSchema,
  author: Author,
  input: WriteTemplateRecordInput,
): Promise<WriteTemplateRecordResult> {
  const { prisma } = deps;
  await assertTemplateRecordWithinCaps(
    { prisma, config: deps.config },
    template,
    input,
  );

  const collection = resolveCollection(template, input.collectionName);

  validateTemplateRecord({
    templateId: template.id,
    schemaVersion: template.latestVersionRow.version,
    collectionName: input.collectionName,
    rowSchema: collection.rowSchema,
    data: input.data,
  });

  const recordKey = input.recordKey ?? `trec_${cuidish()}`;

  let row: TemplateRecord;
  let deduped = false;
  try {
    row = await prisma.$transaction(async (tx) => {
      const col = await tx.templateRecordCollection.upsert({
        where: {
          templateId_name: {
            templateId: template.id,
            name: input.collectionName,
          },
        },
        create: {
          templateId: template.id,
          name: input.collectionName,
          seq: 1,
        },
        update: { seq: { increment: 1 } },
      });
      return tx.templateRecord.create({
        data: {
          collectionId: col.id,
          recordKey,
          data: (input.data ?? null) as Prisma.InputJsonValue,
          version: 1,
          seq: col.seq,
          authorKind: author.kind,
          authorId: author.id,
        },
      });
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existingCollection =
        await prisma.templateRecordCollection.findUnique({
          where: {
            templateId_name: {
              templateId: template.id,
              name: input.collectionName,
            },
          },
        });
      if (!existingCollection) throw err;
      const existing = await prisma.templateRecord.findUnique({
        where: {
          collectionId_recordKey: {
            collectionId: existingCollection.id,
            recordKey,
          },
        },
      });
      if (!existing) throw err;
      row = existing;
      deduped = true;
    } else {
      throw err;
    }
  }

  const serialized = serializeTemplateRecord(row, input.collectionName);
  if (!deduped) {
    publishToTemplate(
      template.id,
      makeTemplateRecordUpsert(input.collectionName, serialized),
    );
  }
  return {
    record: serialized,
    deduped,
  };
}

// -------------------------------------------------------------------------
// Update path (PATCH)
// -------------------------------------------------------------------------

export async function updateTemplateRecord(
  deps: WriteTemplateRecordDeps,
  template: TemplateWithSchema,
  author: Author,
  input: UpdateTemplateRecordInput,
): Promise<UpdateTemplateRecordResult> {
  const { prisma } = deps;
  const collection = resolveCollection(template, input.collectionName);

  validateTemplateRecord({
    templateId: template.id,
    schemaVersion: template.latestVersionRow.version,
    collectionName: input.collectionName,
    rowSchema: collection.rowSchema,
    data: input.data,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const col = await tx.templateRecordCollection.findUnique({
      where: {
        templateId_name: {
          templateId: template.id,
          name: input.collectionName,
        },
      },
    });
    if (!col) {
      throw templateRecordNotFound(input.collectionName, input.recordKey);
    }
    const existing = await tx.templateRecord.findUnique({
      where: {
        collectionId_recordKey: {
          collectionId: col.id,
          recordKey: input.recordKey,
        },
      },
    });
    if (!existing || existing.deletedAt) {
      throw templateRecordNotFound(input.collectionName, input.recordKey);
    }
    if (input.ifMatch !== undefined && existing.version !== input.ifMatch) {
      throw templateRecordVersionConflict(
        input.collectionName,
        serializeTemplateRecord(existing, input.collectionName),
        input.ifMatch,
      );
    }
    const bumpedCol = await tx.templateRecordCollection.update({
      where: { id: col.id },
      data: { seq: { increment: 1 } },
    });
    return tx.templateRecord.update({
      where: { id: existing.id },
      data: {
        data: (input.data ?? null) as Prisma.InputJsonValue,
        version: { increment: 1 },
        seq: bumpedCol.seq,
        // authorship: keep the row's ORIGINAL creator. Update doesn't change
        // authorKind/authorId — same convention as per-pane records and a
        // wiki-page edit.
      },
    });
  });
  // Suppress unused-author warning — kept in the signature for symmetry
  // with writeTemplateRecord and to give callers a single auth shape.
  void author;

  const serialized = serializeTemplateRecord(updated, input.collectionName);
  publishToTemplate(
    template.id,
    makeTemplateRecordUpsert(input.collectionName, serialized),
  );
  return { record: serialized };
}

// -------------------------------------------------------------------------
// Delete path — soft-delete with optimistic lock
// -------------------------------------------------------------------------

export async function deleteTemplateRecord(
  deps: WriteTemplateRecordDeps,
  template: TemplateWithSchema,
  _author: Author,
  input: DeleteTemplateRecordInput,
): Promise<void> {
  const { prisma } = deps;
  resolveCollection(template, input.collectionName); // 404s if undeclared

  const deleted = await prisma.$transaction(async (tx) => {
    const col = await tx.templateRecordCollection.findUnique({
      where: {
        templateId_name: {
          templateId: template.id,
          name: input.collectionName,
        },
      },
    });
    if (!col) {
      throw templateRecordNotFound(input.collectionName, input.recordKey);
    }
    const existing = await tx.templateRecord.findUnique({
      where: {
        collectionId_recordKey: {
          collectionId: col.id,
          recordKey: input.recordKey,
        },
      },
    });
    if (!existing || existing.deletedAt) {
      throw templateRecordNotFound(input.collectionName, input.recordKey);
    }
    if (input.ifMatch !== undefined && existing.version !== input.ifMatch) {
      throw templateRecordVersionConflict(
        input.collectionName,
        serializeTemplateRecord(existing, input.collectionName),
        input.ifMatch,
      );
    }
    const bumpedCol = await tx.templateRecordCollection.update({
      where: { id: col.id },
      data: { seq: { increment: 1 } },
    });
    return tx.templateRecord.update({
      where: { id: existing.id },
      data: {
        deletedAt: new Date(),
        seq: bumpedCol.seq,
      },
    });
  });
  publishToTemplate(
    template.id,
    makeTemplateRecordDelete(input.collectionName, {
      id: deleted.id,
      key: deleted.recordKey,
      seq: deleted.seq,
      deleted_at: (deleted.deletedAt ?? deleted.updatedAt).toISOString(),
    }),
  );
}

// -------------------------------------------------------------------------
// Caps
// -------------------------------------------------------------------------

async function assertTemplateRecordWithinCaps(
  deps: { prisma: PrismaClient; config?: WriteTemplateRecordDeps["config"] },
  template: TemplateWithSchema,
  input: { collectionName: string; data: unknown },
): Promise<void> {
  const maxBytes =
    deps.config?.MAX_RECORD_DATA_BYTES ?? DEFAULT_MAX_RECORD_DATA_BYTES;
  const maxRows =
    deps.config?.MAX_RECORDS_PER_COLLECTION ??
    DEFAULT_MAX_RECORDS_PER_COLLECTION;

  if (
    Buffer.byteLength(JSON.stringify(input.data ?? null), "utf8") > maxBytes
  ) {
    throw errors.payloadTooLarge();
  }

  if (maxRows > 0) {
    const col = await deps.prisma.templateRecordCollection.findUnique({
      where: {
        templateId_name: {
          templateId: template.id,
          name: input.collectionName,
        },
      },
    });
    if (col) {
      const live = await deps.prisma.templateRecord.count({
        where: { collectionId: col.id, deletedAt: null },
      });
      if (live >= maxRows) {
        throw errors.tooManyRequests(
          `template record cap reached for collection '${input.collectionName}' (max ${maxRows} rows)`,
        );
      }
    }
  }
}

// -------------------------------------------------------------------------
// Tombstone sweeper
// -------------------------------------------------------------------------

/**
 * One pass of the template-record tombstone sweeper. Reuses
 * RECORD_TOMBSTONE_TTL_SECONDS — separate sweeper invocations, shared TTL.
 */
export async function sweepTemplateRecordTombstones(
  prisma: PrismaClient,
  ttlSeconds: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - ttlSeconds * 1000);
  const r = await prisma.templateRecord.deleteMany({
    where: { deletedAt: { not: null, lt: cutoff } },
  });
  if (r.count > 0) {
    log.info("template-record tombstone swept", { count: r.count });
  }
  return r.count;
}

// -------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------

function templateRecordCollectionNotFound(
  collectionName: string,
  message: string,
): ApiError {
  return new ApiError(
    404,
    "template_record_collection_not_found",
    message,
    { collection: collectionName },
    "verify the collection name matches one declared in the template's template_record_schema 'x-pane-collections' map",
    false,
  );
}

function templateRecordNotFound(
  collectionName: string,
  recordKey: string,
): ApiError {
  return new ApiError(
    404,
    "template_record_not_found",
    `no template record at key '${recordKey}' in collection '${collectionName}'`,
    { collection: collectionName, key: recordKey },
    "list the collection with GET /v1/templates/:id/template-records/:collection",
    false,
  );
}

function templateRecordVersionConflict(
  collectionName: string,
  current: SerializedTemplateRecord,
  ifMatch: number,
): ApiError {
  return new ApiError(
    409,
    "conflict",
    `template record version mismatch — current version is ${current.version}, caller passed if_match=${ifMatch}`,
    { current },
    "another writer updated the row concurrently; rebase against details.current and retry",
    true,
  );
}

function cuidish(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `c${ts}${rand}`.padEnd(16, "0").slice(0, 24);
}

export type { TemplateRecord, TemplateRecordCollection };
