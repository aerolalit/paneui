// HTTP routes for the records feature (#292).
//
// Mounted at /v1/surfaces/:id/records/:collection. All four CRUD verbs are
// thin wrappers — auth + body parsing + query-param decoding here, all real
// logic in core/records.ts (#291).
//
// Auth: dualAuth — agent owning the surface OR participant token bound to it.
// Same middleware as /v1/surfaces/:id/events.

import { Hono } from "hono";
import { z } from "zod";
import { dualAuth, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import {
  deleteRecord,
  listRecords,
  updateRecord,
  writeRecord,
  type SurfaceWithRecordSchema,
} from "../../core/records.js";

const records = new Hono<AuthEnv>();
records.use("*", dualAuth);

// Cap mirrors event idempotency_key cap; record_key serves the same role
// (natural idempotency key for POST) so the limits line up.
const MAX_RECORD_KEY_LENGTH = 256;
const MAX_RECORDS_PER_PAGE = 200;
const DEFAULT_RECORDS_PER_PAGE = 100;

const postBody = z.object({
  record_key: z.string().min(1).max(MAX_RECORD_KEY_LENGTH).optional(),
  data: z.unknown(),
});

const patchBody = z.object({
  if_match: z.number().int().nonnegative().optional(),
  data: z.unknown(),
});

// DELETE bodies are optional in HTTP; when present they may carry if_match.
const deleteBody = z
  .object({
    if_match: z.number().int().nonnegative().optional(),
  })
  .optional();

function collectionParam(c: { req: { param: (n: string) => string } }): string {
  const name = c.req.param("collection");
  if (!name || name.length === 0) {
    throw errors.invalidRequest(":collection path parameter is required");
  }
  return name;
}

function recordKeyParam(c: { req: { param: (n: string) => string } }): string {
  const k = c.req.param("recordKey");
  if (!k || k.length === 0) {
    throw errors.invalidRequest(":recordKey path parameter is required");
  }
  return k;
}

// GET /v1/surfaces/:id/records/:collection
// Cursor-paginated read with tombstones. `?since=<seq>` returns rows with
// seq > <since>, capped at MAX_RECORDS_PER_PAGE (default 100).
records.get("/", async (c) => {
  const prisma = c.get("prisma");
  const surface = c.get("surface") as unknown as SurfaceWithRecordSchema;
  const collection = collectionParam(c);

  let since = 0;
  const sinceRaw = c.req.query("since");
  if (sinceRaw !== undefined) {
    const n = Number(sinceRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw errors.invalidRequest(
        "?since must be a non-negative integer string",
      );
    }
    since = n;
  }

  let limit = DEFAULT_RECORDS_PER_PAGE;
  const limitRaw = c.req.query("limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RECORDS_PER_PAGE) {
      throw errors.invalidRequest(
        `?limit must be an integer between 1 and ${MAX_RECORDS_PER_PAGE}`,
      );
    }
    limit = n;
  }

  const out = await listRecords(prisma, surface, collection, { since, limit });
  return c.json(out);
});

// POST /v1/surfaces/:id/records/:collection
// Create-or-return-existing. 201 on fresh create, 200 on idempotent dedup.
records.post("/", async (c) => {
  const prisma = c.get("prisma");
  const surface = c.get("surface") as unknown as SurfaceWithRecordSchema;
  const author = c.get("author");
  const collection = collectionParam(c);

  const body = await c.req.json().catch(() => null);
  const parsed = postBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }

  const { record, deduped } = await writeRecord({ prisma }, surface, author, {
    collectionName: collection,
    recordKey: parsed.data.record_key,
    data: parsed.data.data,
  });

  if (deduped) {
    return c.json({ record, deduped: true }, 200);
  }
  return c.json({ record }, 201);
});

// PATCH /v1/surfaces/:id/records/:collection/:recordKey
// Update with optional optimistic locking. 200 on success; 409 with the
// current row in details.current on if_match mismatch.
records.patch("/:recordKey", async (c) => {
  const prisma = c.get("prisma");
  const surface = c.get("surface") as unknown as SurfaceWithRecordSchema;
  const author = c.get("author");
  const collection = collectionParam(c);
  const recordKey = recordKeyParam(c);

  const body = await c.req.json().catch(() => null);
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }

  const { record } = await updateRecord({ prisma }, surface, author, {
    collectionName: collection,
    recordKey,
    data: parsed.data.data,
    ifMatch: parsed.data.if_match,
  });
  return c.json({ record });
});

// DELETE /v1/surfaces/:id/records/:collection/:recordKey
// Soft-delete with optional optimistic locking. 204 on success; 409 with the
// current row on if_match mismatch.
records.delete("/:recordKey", async (c) => {
  const prisma = c.get("prisma");
  const surface = c.get("surface") as unknown as SurfaceWithRecordSchema;
  const author = c.get("author");
  const collection = collectionParam(c);
  const recordKey = recordKeyParam(c);

  // DELETE body is optional. If present, parse for if_match.
  let ifMatch: number | undefined;
  if (c.req.header("content-length") !== "0") {
    const body = await c.req.json().catch(() => null);
    if (body !== null) {
      const parsed = deleteBody.safeParse(body);
      if (!parsed.success) {
        throw errors.invalidRequest(
          "invalid body",
          parsed.error.flatten(),
          "DELETE body is optional; when present it must match { if_match?: number }",
        );
      }
      ifMatch = parsed.data?.if_match;
    }
  }

  await deleteRecord({ prisma }, surface, author, {
    collectionName: collection,
    recordKey,
    ifMatch,
  });
  return c.body(null, 204);
});

export default records;
