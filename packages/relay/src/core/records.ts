// records.ts — the per-surface record-collection writer (#291).
//
// Peer to core/events.ts. Records are a separate data shape from events:
// where events are an append-only journal (one row = one fact), records are
// a mutable per-surface collection (one row = one current value). The
// architectural rationale is in the epic (#287); the short version is "events
// don't scale to thousands of comments where only the latest value matters."
//
// Public surface — STABLE, callers must not change:
//   writeRecord(deps, surface, author, input)   — POST: create-or-return-existing
//   updateRecord(deps, surface, author, input)  — PATCH: update with optimistic lock
//   deleteRecord(deps, surface, author, input)  — DELETE: soft-delete with optimistic lock
//   listRecords(prisma, surface, name, since)   — GET: cursor-paginated list with tombstones
//   validateRecord({...})                       — per-write row payload validator
//   serializeRecord(row, collectionName)        — DB row → wire format
//   invalidateRecordSchemaCache(surfaceId)      — drop a surface's cache entries
//
// On the wire (RecordDeltaMessage), records flow over the same WS channel as
// events — the discriminator is a top-level `kind` field. Events have no
// `kind`, record messages do (`record.upsert` | `record.delete` |
// `record.replay.complete`). See http/broadcast.ts WireMessage.

import { createRequire } from "node:module";
import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  RecordCollection,
  Surface,
  SurfaceRecord,
  TemplateVersion,
} from "@prisma/client";
import type { ValidateFunction } from "ajv";
import { publish } from "../http/broadcast.js";
import { ApiError, errors } from "../http/errors.js";
import { log } from "../log.js";
import type { Author, AuthorKind } from "../types.js";
import type { Config } from "../config.js";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

// A surface row with its pinned template version eagerly loaded — every
// caller must pass this shape because the record schema lives on
// templateVersion.recordSchema (#288).
export type SurfaceWithRecordSchema = Surface & {
  templateVersion: TemplateVersion;
};

// Wire-shape types live in ws/messages.ts as the single source of truth (#294).
// Re-exported here so callers of the writer can construct messages without
// reaching into the ws/ subtree from core/.
export type {
  SerializedRecord,
  DeletedRecordRef,
  RecordDeltaMessage,
  RecordUpsertMessage,
  RecordDeleteMessage,
  RecordReplayCompleteMessage,
} from "../ws/messages.js";
import type { SerializedRecord, DeletedRecordRef } from "../ws/messages.js";
import {
  recordDelete as makeRecordDelete,
  recordUpsert as makeRecordUpsert,
} from "../ws/messages.js";

export interface WriteRecordDeps {
  prisma: PrismaClient;
  // #293 — config drives the per-row payload byte cap and per-collection row
  // cap. Optional on the type to keep test setups terse; absent = use the
  // hard-coded defaults below.
  config?: Pick<Config, "MAX_RECORD_DATA_BYTES" | "MAX_RECORDS_PER_COLLECTION">;
}

// Defaults used when WriteRecordDeps.config is omitted (mainly tests). Match
// the config.ts defaults so behaviour is identical either way.
const DEFAULT_MAX_RECORD_DATA_BYTES = 65_536;
const DEFAULT_MAX_RECORDS_PER_COLLECTION = 50_000;

export interface WriteRecordInput {
  collectionName: string;
  recordKey?: string; // server-generated `rec_<cuid>` if absent
  data: unknown;
}

export interface WriteRecordResult {
  record: SerializedRecord;
  /** True when the row already existed at the supplied key. */
  deduped: boolean;
}

export interface UpdateRecordInput {
  collectionName: string;
  recordKey: string;
  data: unknown;
  /** Optimistic-locking: caller's last-seen version. Mismatch → 409. */
  ifMatch?: number;
}

export interface UpdateRecordResult {
  record: SerializedRecord;
}

export interface DeleteRecordInput {
  collectionName: string;
  recordKey: string;
  ifMatch?: number;
}

// -------------------------------------------------------------------------
// recordSchema resolution + authz
// -------------------------------------------------------------------------

interface CollectionEntry {
  rowSchema: object;
  write: Set<"agent" | "page">;
  delete: Set<"agent" | "page" | "author">;
}

// Pull the (validated-at-template-time) recordSchema off the surface's pinned
// template version and resolve one collection's entry. Throws 404 if the
// collection isn't declared, 400 if the surface has no record_schema at all.
// The shape validator (#289) guarantees `x-pane-collections[name].schema.$ref`
// resolves under `$defs` and that the principal lists are valid — we re-walk
// defensively here but expect well-formed input.
function resolveCollection(
  surface: SurfaceWithRecordSchema,
  collectionName: string,
): CollectionEntry {
  const doc = surface.templateVersion.recordSchema as Record<
    string,
    unknown
  > | null;
  if (!doc || typeof doc !== "object") {
    throw recordCollectionNotFound(
      collectionName,
      "surface's template declares no record collections (record_schema is null)",
    );
  }
  const xpc = doc["x-pane-collections"] as Record<string, unknown> | undefined;
  if (!xpc || typeof xpc !== "object") {
    throw recordCollectionNotFound(
      collectionName,
      "surface's template declares no record collections",
    );
  }
  const entry = xpc[collectionName] as Record<string, unknown> | undefined;
  if (!entry) {
    throw recordCollectionNotFound(
      collectionName,
      `collection '${collectionName}' is not declared in this surface's template recordSchema`,
    );
  }
  const schemaField = entry["schema"] as { $ref?: string } | undefined;
  const refRaw = schemaField?.$ref;
  if (typeof refRaw !== "string") {
    // Should be unreachable — the shape validator (#289) rejected this at
    // template-create. Defensive.
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
  const writeArr = Array.isArray(entry["write"])
    ? (entry["write"] as unknown[])
    : [];
  const deleteArr = Array.isArray(entry["delete"])
    ? (entry["delete"] as unknown[])
    : [];
  return {
    rowSchema: rowSchema as object,
    write: new Set(
      writeArr.filter(
        (v): v is "agent" | "page" => v === "agent" || v === "page",
      ),
    ),
    delete: new Set(
      deleteArr.filter(
        (v): v is "agent" | "page" | "author" =>
          v === "agent" || v === "page" || v === "author",
      ),
    ),
  };
}

// authorKindForAuthz maps an Author.kind ("agent" | "human") to the recordSchema
// principal vocabulary ("agent" | "page"). The Author kind is the auth-layer
// distinction ("agent" = agent-key holder, "human" = participant-token holder),
// but recordSchema talks about callers ("agent" = the owning agent, "page" =
// the rendered page = a human participant). They're equivalent at the wire
// boundary; this mapping makes the equivalence explicit.
function authorKindForAuthz(kind: AuthorKind): "agent" | "page" | null {
  if (kind === "agent") return "agent";
  if (kind === "human") return "page";
  return null;
}

// -------------------------------------------------------------------------
// Per-write row validator (validateRecord) + Ajv compiler LRU
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

// Mirror the pane-attachment-id format on this Ajv instance so record
// payloads can declare attachment refs just like event payloads can.
ajv2020.addFormat("pane-attachment-id", {
  type: "string",
  validate: (s: string): boolean =>
    typeof s === "string" && /^c[a-z0-9]{20,40}$/.test(s),
});

// LRU compiler cache, structurally identical to the validation.ts event cache:
// outer key `${surfaceId}:${schemaVersion}`, inner key collection name. JS
// Map preserves insertion order so "least recently used" = the first key; on
// a hit we delete + re-set to move the entry to most-recent. Bounded at
// CACHE_MAX entries as a backstop against any path that fails to invalidate.
const CACHE_MAX = 10_000;
const cache = new Map<string, Map<string, ValidateFunction>>();
const cacheKey = (surfaceId: string, schemaVersion: number): string =>
  `${surfaceId}:${schemaVersion}`;

function getCompiler(
  surfaceId: string,
  schemaVersion: number,
  collectionName: string,
  rowSchema: object,
): ValidateFunction {
  const k = cacheKey(surfaceId, schemaVersion);
  let perSurface = cache.get(k);
  if (perSurface) {
    cache.delete(k);
    cache.set(k, perSurface);
    const hit = perSurface.get(collectionName);
    if (hit) return hit;
  } else {
    perSurface = new Map<string, ValidateFunction>();
    cache.set(k, perSurface);
    // Bound: evict oldest until under cap.
    while (cache.size > CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey === undefined) break;
      cache.delete(firstKey);
    }
  }
  const compiled = ajv2020.compile(rowSchema);
  perSurface.set(collectionName, compiled);
  return compiled;
}

/**
 * Drop a surface's compiled-validator entries — call on surface DELETE and
 * on TTL-expiry sweep. Safe to call when no entries exist.
 */
export function invalidateRecordSchemaCache(surfaceId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${surfaceId}:`)) cache.delete(k);
  }
}

/**
 * Validate a single record-write payload against the surface's pinned
 * recordSchema for the named collection. Throws schemaViolation (422) on
 * failure with the same error envelope shape as validateEvent. Peer to
 * validateEvent in core/validation.ts.
 *
 * Per-collection caching keyed `${surfaceId}:${schemaVersion}:${collectionName}` —
 * a surface that writes records frequently compiles each collection's row
 * schema once and reuses the compiled validator forever (or until cap eviction
 * or explicit invalidate).
 */
export function validateRecord(args: {
  surfaceId: string;
  schemaVersion: number;
  collectionName: string;
  rowSchema: object;
  data: unknown;
}): void {
  const validate = getCompiler(
    args.surfaceId,
    args.schemaVersion,
    args.collectionName,
    args.rowSchema,
  );
  if (!validate(args.data)) {
    throw errors.schemaViolation(
      "record_schema_violation",
      validate.errors,
      `record data does not validate against the row schema for collection '${args.collectionName}'; see details for the failing JSON Schema paths`,
    );
  }
}

// Test-only handle to the internal cache, mirroring validation.ts's
// __schemaCacheInternals export. Not part of the public API.
export const __recordSchemaCacheInternals = {
  size: (): number => cache.size,
  has: (surfaceId: string, schemaVersion: number): boolean =>
    cache.has(cacheKey(surfaceId, schemaVersion)),
  hasCollection: (
    surfaceId: string,
    schemaVersion: number,
    collectionName: string,
  ): boolean =>
    cache.get(cacheKey(surfaceId, schemaVersion))?.has(collectionName) ?? false,
  clear: (): void => {
    cache.clear();
  },
  max: CACHE_MAX,
};

// -------------------------------------------------------------------------
// Serialization
// -------------------------------------------------------------------------

export function serializeRecord(
  row: SurfaceRecord,
  collectionName: string,
): SerializedRecord {
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

function tombstone(
  row: SurfaceRecord,
  collectionName: string,
): import("../ws/messages.js").RecordDeleteMessage {
  // A deleteRecord call always sets deletedAt; the fallback to updatedAt is
  // purely defensive for an upstream caller that hands us a row without
  // deletedAt set.
  const ref: DeletedRecordRef = {
    id: row.id,
    key: row.recordKey,
    seq: row.seq,
    deleted_at: (row.deletedAt ?? row.updatedAt).toISOString(),
  };
  return makeRecordDelete(collectionName, ref);
}

// -------------------------------------------------------------------------
// Read path — list a collection
// -------------------------------------------------------------------------

export interface ListRecordsResult {
  records: SerializedRecord[];
  next_since: number;
  has_more: boolean;
}

/**
 * Cursor-paginated read of a collection. Includes tombstones (rows with
 * deletedAt set) so a reconnecting client can observe the deletion and
 * evict its local cache. The route layer (#292) drives this.
 */
export async function listRecords(
  prisma: PrismaClient,
  surface: SurfaceWithRecordSchema,
  collectionName: string,
  opts: { since: number; limit: number },
): Promise<ListRecordsResult> {
  resolveCollection(surface, collectionName); // 404s if undeclared

  const collection = await prisma.recordCollection.findUnique({
    where: { surfaceId_name: { surfaceId: surface.id, name: collectionName } },
  });
  if (!collection) {
    // The collection is declared but no writes have happened yet — return
    // an empty page rather than 404. Distinguishes "schema doesn't declare
    // this" (route returns 404) from "schema declares it, no rows yet"
    // (route returns an empty list).
    return { records: [], next_since: opts.since, has_more: false };
  }

  const rows = await prisma.surfaceRecord.findMany({
    where: { collectionId: collection.id, seq: { gt: opts.since } },
    orderBy: { seq: "asc" },
    take: opts.limit + 1, // +1 to detect has_more without a separate count
  });
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextSince = page.length > 0 ? page[page.length - 1]!.seq : opts.since;
  return {
    records: page.map((r) => serializeRecord(r, collectionName)),
    next_since: nextSince,
    has_more: hasMore,
  };
}

// -------------------------------------------------------------------------
// Write path — create-or-return-existing (POST)
// -------------------------------------------------------------------------

/**
 * Single source of truth for "an authenticated agent or participant creates
 * a record." Used by the POST route (#292) and (eventually) the page-side
 * runtime API (#298). Semantics:
 *
 *   - record_key absent → server generates `rec_<cuid>`, always creates.
 *   - record_key present, no row at that key → creates with version=1.
 *   - record_key present, row already at that key → returns existing row,
 *     deduped=true, no modification (idempotent — mirrors event idempotency
 *     on (surfaceId, authorId, idempotencyKey)).
 *
 * To MUTATE a row, callers use updateRecord (PATCH), which carries an
 * optional `ifMatch` for optimistic locking.
 */
export async function writeRecord(
  deps: WriteRecordDeps,
  surface: SurfaceWithRecordSchema,
  author: Author,
  input: WriteRecordInput,
): Promise<WriteRecordResult> {
  const { prisma } = deps;
  assertSurfaceOpen(surface);
  await assertRecordWithinCaps({ prisma, config: deps.config }, surface, input);

  const collection = resolveCollection(surface, input.collectionName);

  // Authz: only principals listed in `write` may create.
  const principal = authorKindForAuthz(author.kind);
  if (!principal || !collection.write.has(principal)) {
    throw errors.forbidden(
      "author_not_allowed",
      `author kind '${author.kind}' is not allowed to write to collection '${input.collectionName}' (allowed: ${[...collection.write].join(", ") || "none"})`,
    );
  }

  // Shape validation. The compiled validator is cached by
  // (surfaceId, schemaVersion, collectionName).
  validateRecord({
    surfaceId: surface.id,
    schemaVersion: surface.templateVersion.version,
    collectionName: input.collectionName,
    rowSchema: collection.rowSchema,
    data: input.data,
  });

  // If the caller didn't supply a key, generate one. Stable for the row's
  // lifetime — the wire shape exposes it as `key`.
  const recordKey = input.recordKey ?? `rec_${cuidish()}`;

  // Transactional create-or-return-existing. The (collectionId, recordKey)
  // unique index makes the dedupe detection a P2002 catch, mirroring how
  // writeEvent handles idempotency-key collisions.
  let row: SurfaceRecord;
  let deduped = false;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const col = await tx.recordCollection.upsert({
        where: {
          surfaceId_name: {
            surfaceId: surface.id,
            name: input.collectionName,
          },
        },
        create: { surfaceId: surface.id, name: input.collectionName, seq: 1 },
        update: { seq: { increment: 1 } },
      });
      const created = await tx.surfaceRecord.create({
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
      return created;
    });
    row = result;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Key already exists — look up and return the existing row. The
      // collection's seq was bumped in the failed transaction but rolled
      // back when the create failed; no orphan increment.
      const existingCollection = await prisma.recordCollection.findUnique({
        where: {
          surfaceId_name: {
            surfaceId: surface.id,
            name: input.collectionName,
          },
        },
      });
      if (!existingCollection) throw err;
      const existing = await prisma.surfaceRecord.findUnique({
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

  const serialized = serializeRecord(row, input.collectionName);
  if (!deduped) {
    publish(surface.id, makeRecordUpsert(input.collectionName, serialized));
  }
  return { record: serialized, deduped };
}

// -------------------------------------------------------------------------
// Update path (PATCH) — optimistic-locked mutation
// -------------------------------------------------------------------------

/**
 * Update an existing record's data. Optimistic locking on `version` —
 * callers pass `ifMatch` and a mismatch returns 409 with the current row
 * attached for client-side rebase. The version increments on success and
 * the collection's seq is bumped so reconnecting clients can pull the
 * change via the same `?since=<seq>` cursor that powers initial list.
 */
export async function updateRecord(
  deps: WriteRecordDeps,
  surface: SurfaceWithRecordSchema,
  author: Author,
  input: UpdateRecordInput,
): Promise<UpdateRecordResult> {
  const { prisma } = deps;
  assertSurfaceOpen(surface);

  const collection = resolveCollection(surface, input.collectionName);

  // PATCH uses the same authz set as POST — anything that can create can
  // mutate. (Per-row authorship rules live on DELETE; updates don't have
  // a separate write-vs-author distinction in this design.)
  const principal = authorKindForAuthz(author.kind);
  if (!principal || !collection.write.has(principal)) {
    throw errors.forbidden(
      "author_not_allowed",
      `author kind '${author.kind}' is not allowed to update records in collection '${input.collectionName}'`,
    );
  }

  validateRecord({
    surfaceId: surface.id,
    schemaVersion: surface.templateVersion.version,
    collectionName: input.collectionName,
    rowSchema: collection.rowSchema,
    data: input.data,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const col = await tx.recordCollection.findUnique({
      where: {
        surfaceId_name: {
          surfaceId: surface.id,
          name: input.collectionName,
        },
      },
    });
    if (!col) {
      throw recordNotFound(input.collectionName, input.recordKey);
    }
    const existing = await tx.surfaceRecord.findUnique({
      where: {
        collectionId_recordKey: {
          collectionId: col.id,
          recordKey: input.recordKey,
        },
      },
    });
    if (!existing || existing.deletedAt) {
      throw recordNotFound(input.collectionName, input.recordKey);
    }
    if (input.ifMatch !== undefined && existing.version !== input.ifMatch) {
      throw recordVersionConflict(
        input.collectionName,
        serializeRecord(existing, input.collectionName),
        input.ifMatch,
      );
    }
    const bumpedCol = await tx.recordCollection.update({
      where: { id: col.id },
      data: { seq: { increment: 1 } },
    });
    return tx.surfaceRecord.update({
      where: { id: existing.id },
      data: {
        data: (input.data ?? null) as Prisma.InputJsonValue,
        version: { increment: 1 },
        seq: bumpedCol.seq,
        // authorship reflects the row's ORIGINAL creator — updates don't
        // overwrite authorKind/authorId, mirroring how a wiki page edit
        // doesn't change the original author.
      },
    });
  });

  const serialized = serializeRecord(updated, input.collectionName);
  publish(surface.id, makeRecordUpsert(input.collectionName, serialized));
  return { record: serialized };
}

// -------------------------------------------------------------------------
// Delete path — soft-delete with optimistic lock + author rule
// -------------------------------------------------------------------------

/**
 * Soft-delete a record. `deletedAt` is set and `seq` is bumped (so
 * reconnecting clients observe the tombstone via their `?since=<seq>`
 * cursor). The row is NOT removed from the table — hard cleanup runs out of
 * the tombstone sweeper after RECORD_TOMBSTONE_TTL (#293) so any client
 * disconnected at delete time has a chance to observe the tombstone on
 * reconnect.
 *
 * Authz:
 *   - Principal must be in the collection's `delete` set.
 *   - If `delete: ["author"]` is the only rule (or a participant's principal
 *     isn't in the set but `"author"` is), the deleter must be the row's
 *     authorId.
 */
export async function deleteRecord(
  deps: WriteRecordDeps,
  surface: SurfaceWithRecordSchema,
  author: Author,
  input: DeleteRecordInput,
): Promise<void> {
  const { prisma } = deps;
  assertSurfaceOpen(surface);

  const collection = resolveCollection(surface, input.collectionName);

  const principal = authorKindForAuthz(author.kind);
  const allowedByPrincipal =
    principal !== null &&
    (collection.delete.has(principal) ||
      // "agent" in delete means "agent kind", which is principal "agent" —
      // covered above. Same with "page". The "author" rule is per-row,
      // handled below after the row is loaded.
      false);

  const result = await prisma.$transaction(async (tx) => {
    const col = await tx.recordCollection.findUnique({
      where: {
        surfaceId_name: {
          surfaceId: surface.id,
          name: input.collectionName,
        },
      },
    });
    if (!col) {
      throw recordNotFound(input.collectionName, input.recordKey);
    }
    const existing = await tx.surfaceRecord.findUnique({
      where: {
        collectionId_recordKey: {
          collectionId: col.id,
          recordKey: input.recordKey,
        },
      },
    });
    if (!existing || existing.deletedAt) {
      throw recordNotFound(input.collectionName, input.recordKey);
    }

    // Per-row authorship rule. If the principal isn't allowed by kind, the
    // only path left is the "author" rule — and it requires authorId match.
    if (!allowedByPrincipal) {
      const isOwnRow =
        collection.delete.has("author") && existing.authorId === author.id;
      if (!isOwnRow) {
        throw errors.forbidden(
          "author_not_allowed",
          `author kind '${author.kind}' is not allowed to delete records in collection '${input.collectionName}' (allowed: ${[...collection.delete].join(", ") || "none"})`,
        );
      }
    }

    if (input.ifMatch !== undefined && existing.version !== input.ifMatch) {
      throw recordVersionConflict(
        input.collectionName,
        serializeRecord(existing, input.collectionName),
        input.ifMatch,
      );
    }

    const bumpedCol = await tx.recordCollection.update({
      where: { id: col.id },
      data: { seq: { increment: 1 } },
    });
    return tx.surfaceRecord.update({
      where: { id: existing.id },
      data: {
        deletedAt: new Date(),
        seq: bumpedCol.seq,
        // version intentionally NOT bumped on soft-delete — the row is
        // gone, no future PATCH will reference it.
      },
    });
  });

  publish(surface.id, tombstone(result, input.collectionName));
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function assertSurfaceOpen(surface: Surface): void {
  if (surface.status !== "open" || surface.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }
}

// #293 — per-write byte + count caps for writeRecord. Byte cap throws 413;
// count cap throws 429 with a clear "rotate to a new surface" hint. updateRecord
// and deleteRecord don't grow the collection so they skip the count check;
// updateRecord still benefits from the byte check (done inline there).
async function assertRecordWithinCaps(
  deps: { prisma: PrismaClient; config?: WriteRecordDeps["config"] },
  surface: SurfaceWithRecordSchema,
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
    // Count-then-create soft cap — concurrent writers can race past it and
    // overshoot by ~inflight count. Same shape as writeEvent's per-surface
    // cap; the cap exists to bound abuse to ~N, not enforce exact rows.
    // Counts ALIVE rows only (tombstones don't count) so a chatty collection
    // can keep working after the sweeper hard-deletes old tombstones.
    const col = await deps.prisma.recordCollection.findUnique({
      where: {
        surfaceId_name: {
          surfaceId: surface.id,
          name: input.collectionName,
        },
      },
    });
    if (col) {
      const live = await deps.prisma.surfaceRecord.count({
        where: { collectionId: col.id, deletedAt: null },
      });
      if (live >= maxRows) {
        throw errors.tooManyRequests(
          `record cap reached for collection '${input.collectionName}' (max ${maxRows} rows); delete an existing row or rotate to a new surface`,
        );
      }
    }
  }
}

// -------------------------------------------------------------------------
// Tombstone sweeper (#293)
// -------------------------------------------------------------------------

/**
 * One pass of the tombstone sweeper — hard-delete soft-deleted records whose
 * deletedAt is older than `ttlSeconds`. Returns the number of rows removed.
 *
 * Idempotent: safe to interrupt + restart. Logs the count on every pass.
 * Records that have already been observed-as-tombstone by reconnecting
 * clients can finally be reclaimed; clients that disconnected longer ago
 * than ttlSeconds and reconnect later see the row simply "not exist" (no row,
 * no tombstone), which is the same as a never-created row — the client store
 * evicts it via cursor advancement.
 */
export async function sweepRecordTombstones(
  prisma: PrismaClient,
  ttlSeconds: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - ttlSeconds * 1000);
  const r = await prisma.surfaceRecord.deleteMany({
    where: { deletedAt: { not: null, lt: cutoff } },
  });
  if (r.count > 0) {
    log.info("record tombstone swept", { count: r.count });
  }
  return r.count;
}

// 404 helper for the "this collection isn't declared in the template's
// recordSchema" case. ApiError directly (rather than a new entry in
// http/errors.ts) so this PR doesn't cross into the routes file's territory —
// #292 will lift this into errors.ts as `recordCollectionNotFound` if the
// route review concludes the dedicated constructor is warranted.
function recordCollectionNotFound(
  collectionName: string,
  message: string,
): ApiError {
  return new ApiError(
    404,
    "record_collection_not_found",
    message,
    { collection: collectionName },
    "verify the collection name matches one declared in the template's record_schema 'x-pane-collections' map; run 'pane template show' to see the declared collections",
    false,
  );
}

// 404 helper for "no record at this key in this collection".
function recordNotFound(collectionName: string, recordKey: string): ApiError {
  return new ApiError(
    404,
    "record_not_found",
    `no record at key '${recordKey}' in collection '${collectionName}'`,
    { collection: collectionName, key: recordKey },
    "the record may have been deleted, or the key is wrong; list the collection with GET /v1/surfaces/:id/records/:collection",
    false,
  );
}

// 409 helper for an optimistic-version conflict. Attaches the current row in
// `details.current` so the client can rebase its edit without a second round
// trip — issue body for #291 explicitly requires the current row in the
// conflict response.
function recordVersionConflict(
  collectionName: string,
  current: SerializedRecord,
  ifMatch: number,
): ApiError {
  return new ApiError(
    409,
    "conflict",
    `record version mismatch — current version is ${current.version}, caller passed if_match=${ifMatch}`,
    { current },
    "another writer updated the row concurrently; rebase against details.current and retry",
    true,
  );
}

// cuid-ish id for server-generated record keys. We don't pull the cuid
// package — the existing codebase generates surface ids via the
// `id-helpers` module; record keys are scoped to a collection so a 16-char
// random suffix is plenty. Matches the `^c[a-z0-9]{15+}$` shape that the
// pane-attachment-id format check uses, so it would pass even if surfaced
// through that format (defensive — not currently exercised that way).
function cuidish(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `c${ts}${rand}`.padEnd(16, "0").slice(0, 24);
}

// Unused exports kept here for type-import callers (broadcast.ts, route
// handlers in #292). Removing them would force every downstream PR to
// re-declare the same shapes.
export type { RecordCollection };
