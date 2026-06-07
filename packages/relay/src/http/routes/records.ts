// HTTP routes for the records feature (#292).
//
// Mounted at /v1/panes/:id/records/:collection. All four CRUD verbs are
// thin wrappers — auth + body parsing + query-param decoding here, all real
// logic in core/records.ts (#291).
//
// Auth (recordsAuth, below): a UNION of two models so the records API matches
// how events + the /p share page + the WS emit path are reached —
//   1. Bearer token  → the same resolution dualAuth uses: an agent owning the
//      pane, or a participant token bound to it (F-02 cookie binding enforced).
//   2. Cookie / public → the SAME access model /p/:paneId uses (resolveAccess):
//      owner (cookie) / participant-grant / viewer-grant / public-guest /
//      link-mode anon. Read is allowed for any allow-decision; WRITE requires
//      EMIT capability (owner, participant-grant, public visitor) — a read-only
//      caller (viewer grant, link-mode anon) gets 403 `read_only`, mirroring the
//      WS read-only rejection (#445). invite_only non-grantee → 404 (no oracle).
//
// Before #449 this was a blanket `dualAuth`, so EVERY cookie/public caller —
// including a logged-in OWNER opening their own pane at /panes/:id and any
// public-pane visitor — 401'd, even though events already worked for them over
// the ws-ticket'd WebSocket. recordsAuth closes that gap.

import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { resolveBearer, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import { log } from "../../log.js";
import { clientIp } from "../rate-limit.js";
import type { Author } from "../../types.js";
import {
  deleteRecord,
  listRecords,
  updateRecord,
  writeRecord,
  type PaneWithRecordSchema,
} from "../../core/records.js";
import {
  loadPane,
  resolveAccess,
  resolveHumanFromCookie,
  type Access,
} from "./pane-access.js";
import {
  getOrCreateIdentityParticipant,
  getOrCreatePublicGuestParticipant,
  granteeIdentityId,
  OWNER_IDENTITY_ID,
} from "./identity-participant.js";

const records = new Hono<AuthEnv>();

// HTTP verbs that MUTATE records. A read-or-better access decision is enough
// for the others (just GET on "/"); these additionally require EMIT capability.
const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE"]);

// Resolve the records-API caller and authorize the request, then stash the
// SAME context the handlers consume (`pane` as PaneWithRecordSchema, `author`).
// One of two paths runs depending on whether a Bearer token is present:
//
//   TOKEN PATH (Authorization: Bearer …) — preserves the pre-#449 dualAuth
//   behaviour byte-for-byte: an agent owning the pane, or a participant token
//   bound to it (F-02 cookie binding still enforced). A trashed pane → 410, a
//   non-owning agent / cross-pane or unbound token → 404. EMIT-capable.
//
//   COOKIE / PUBLIC PATH (no Authorization header) — resolveAccess decides as
//   it does for /p/:paneId. GET needs only an allow-decision; a write needs
//   canEmit. Author identity is stamped from the resolved slot via the lazy
//   getOrCreate… helpers (owner / grantee / public-guest / logged-in identity).
const recordsAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const prisma = c.get("prisma");
  const paneId = c.req.param("id");
  if (!paneId) throw errors.notFound();
  const isWrite = WRITE_METHODS.has(c.req.method);

  const authHeader = c.req.header("authorization");
  if (authHeader) {
    // ---- Token path: identical resolution + outcomes to the old dualAuth. ----
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match) throw errors.unauthorized();
    const token = match[1]!.trim();
    const resolved = await resolveBearer(
      prisma,
      token,
      "both",
      c.req.header("cookie") ?? null,
    );
    if (!resolved) throw errors.notFound();

    if (resolved.kind === "agent") {
      const pane = await prisma.pane.findUnique({
        where: { id: paneId },
        include: { templateVersion: true },
      });
      if (!pane || pane.agentId !== resolved.agent.id) throw errors.notFound();
      // F-08 — a trashed pane stays status="open" until the sweeper runs; refuse
      // it here exactly as dualAuth did so it isn't mutable/readable via records.
      if (pane.deletedAt !== null) throw errors.softDeleted("pane");
      prisma.agent
        .update({
          where: { id: resolved.agent.id },
          data: { lastUsedAt: new Date() },
        })
        .catch((err: unknown) =>
          log.warn("lastUsedAt update failed", {
            agentId: resolved.agent.id,
            error: String(err),
          }),
        );
      c.set("agent", resolved.agent);
      c.set("pane", pane);
      c.set("author", { kind: "agent", id: resolved.agent.id });
      return next();
    }

    // Participant token. resolveBearer already enforced F-02 (cookie binding)
    // and revocation; here we re-check it belongs to THIS pane + soft-delete.
    if (resolved.participant.paneId !== paneId) throw errors.notFound();
    if (resolved.pane.deletedAt !== null) throw errors.softDeleted("pane");
    c.set("pane", resolved.pane);
    c.set("participant", resolved.participant);
    c.set("author", {
      kind: resolved.participant.kind === "agent" ? "agent" : "human",
      id: resolved.participant.identityId,
    });
    return next();
  }

  // ---- Cookie / public path: the /p/:paneId access model (resolveAccess). ----
  const human = await resolveHumanFromCookie(c);
  const pane = await loadPane(prisma, paneId);
  const access: Access = await resolveAccess(prisma, pane, human);
  // login (logged-out invite_only) and not_found both collapse to the generic
  // 404 here — API callers don't redirect, and neither outcome is an existence
  // oracle (same shape as /p/:paneId/ws-ticket).
  if (access.kind !== "allow") throw errors.notFound();

  // Owner override. resolveAccess resolves `link` mode (the default) to
  // read-only for EVERYONE — including the owner, because /p is the share view.
  // But the OWNER reaching records over their own shell (/panes/:id) is always
  // emit-capable, independent of accessMode — exactly as owner-shell's
  // ws-ticket route (assertOwner → OWNER_IDENTITY_ID, no mode gate) treats them.
  // So an owner is emit-capable here regardless of the mode resolveAccess saw.
  const isOwner =
    human !== null &&
    pane !== null &&
    pane.deletedAt === null &&
    pane.ownerHumanId === human.id;
  const canEmit = access.canEmit || isOwner;

  // A write requires EMIT capability. A read-only caller (viewer grant, link-
  // mode anon) can GET but not mutate → 403 read_only, mirroring the WS frame
  // rejection in ws/handler.ts. Checked before any author row is minted.
  if (isWrite && !canEmit) {
    throw errors.forbidden(
      "read_only",
      "this pane is read-only for you; writing records requires participant access",
    );
  }

  // Anonymous public writes are a spam surface (shared h_public author). Apply
  // the dedicated stricter per-IP limiter BEFORE minting the guest row / doing
  // any write work. Only anonymous (no login) emit-capable writes hit this; a
  // logged-in owner/grantee writes under the general limiter only.
  const isAnonPublicWrite =
    isWrite && access.isPublic && access.humanId === null;
  if (isAnonPublicWrite) {
    const ip = clientIp(c, c.get("config").TRUSTED_PROXY);
    const ok = await c.get("anonRecordWriteLimiter").check("rec:" + ip);
    if (!ok) {
      log.warn("anonymous record-write rate limit tripped", { paneId, ip });
      throw errors.tooManyRequests(
        "anonymous record-write rate limit exceeded for this pane",
      );
    }
  }

  // Stamp the author from the resolved identity slot, lazily ensuring a
  // Participant row exists for the (paneId, identity) pair — reusing the #445
  // helpers so the record's authorId namespace matches events exactly. Only
  // mint on a WRITE: a read handler never reads `author`, and minting a guest
  // row for every anonymous GET (or for an unsupported verb that 405s in the
  // fallback below) would create spurious participant rows.
  if (isWrite) {
    let author: Author;
    if (access.humanId) {
      const identityId =
        pane!.ownerHumanId === access.humanId
          ? OWNER_IDENTITY_ID
          : granteeIdentityId(access.humanId);
      const participant = await getOrCreateIdentityParticipant(
        prisma,
        pane!.id,
        access.humanId,
        identityId,
      );
      author = { kind: "human", id: participant.identityId };
    } else {
      // Anonymous public visitor → the shared per-pane guest identity.
      const guest = await getOrCreatePublicGuestParticipant(prisma, pane!.id);
      author = { kind: "human", id: guest.identityId };
    }
    c.set("author", author);
  }

  c.set("pane", pane as unknown as PaneWithRecordSchema);
  await next();
};

records.use("*", recordsAuth);

// Cap mirrors event idempotency_key cap; record_key serves the same role
// (natural idempotency key for POST) so the limits line up.
const MAX_RECORD_KEY_LENGTH = 256;
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

// GET /v1/panes/:id/records/:collection
// Cursor-paginated read with tombstones. `?since=<seq>` returns rows with
// seq > <since>, capped at MAX_RECORDS_PER_PAGE (default 100).
records.get("/", async (c) => {
  const prisma = c.get("prisma");
  const pane = c.get("pane") as unknown as PaneWithRecordSchema;
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

  const cap = c.get("config").MAX_RECORDS_PER_PAGE;
  let limit = Math.min(DEFAULT_RECORDS_PER_PAGE, cap);
  const limitRaw = c.req.query("limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > cap) {
      throw errors.invalidRequest(
        `?limit must be an integer between 1 and ${cap}`,
      );
    }
    limit = n;
  }

  const out = await listRecords(prisma, pane, collection, { since, limit });
  return c.json(out);
});

// POST /v1/panes/:id/records/:collection
// Create-or-return-existing. 201 on fresh create, 200 on idempotent dedup.
records.post("/", async (c) => {
  const prisma = c.get("prisma");
  const pane = c.get("pane") as unknown as PaneWithRecordSchema;
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

  const { record, deduped } = await writeRecord(
    { prisma, config: c.get("config") },
    pane,
    author,
    {
      collectionName: collection,
      recordKey: parsed.data.record_key,
      data: parsed.data.data,
    },
  );

  if (deduped) {
    return c.json({ record, deduped: true }, 200);
  }
  return c.json({ record }, 201);
});

// PATCH /v1/panes/:id/records/:collection/:recordKey
// Update with optional optimistic locking. 200 on success; 409 with the
// current row in details.current on if_match mismatch.
records.patch("/:recordKey", async (c) => {
  const prisma = c.get("prisma");
  const pane = c.get("pane") as unknown as PaneWithRecordSchema;
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

  const { record } = await updateRecord(
    { prisma, config: c.get("config") },
    pane,
    author,
    {
      collectionName: collection,
      recordKey,
      data: parsed.data.data,
      ifMatch: parsed.data.if_match,
    },
  );
  return c.json({ record });
});

// DELETE /v1/panes/:id/records/:collection/:recordKey
// Soft-delete with optional optimistic locking. 204 on success; 409 with the
// current row on if_match mismatch.
records.delete("/:recordKey", async (c) => {
  const prisma = c.get("prisma");
  const pane = c.get("pane") as unknown as PaneWithRecordSchema;
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

  await deleteRecord({ prisma }, pane, author, {
    collectionName: collection,
    recordKey,
    ifMatch,
  });
  return c.body(null, 204);
});

// Fallback handlers for unsupported verbs on the records subtree.
//
// Why these exist: participants-human is mounted at `app.route("/v1/panes",
// participantsHuman)` and registers `participantsHuman.use("*", requireHuman)`
// — a wildcard cookie-auth middleware that matches every path under
// /v1/panes/*, including this records subtree. When a request used a verb
// the records subrouter didn't handle (e.g. PUT or GET on /:recordKey),
// the request bubbled past records.ts, hit that cookie-auth wildcard,
// found no login cookie, and returned 401 — a misleading "unauthorized"
// for what was really a method-not-allowed.
//
// `.all()` only matches verbs that aren't already handled, so the explicit
// GET/POST on "/" and PATCH/DELETE on "/:recordKey" above still win.
records.all("/:recordKey", (c) => {
  c.header("Allow", "PATCH, DELETE");
  throw errors.methodNotAllowed(
    `method ${c.req.method} not allowed on this route`,
    "the records HTTP API supports PATCH (update) and DELETE on /:recordKey; single-record reads happen over the WebSocket replay stream, not HTTP — see SPEC.md#http-api-v1",
  );
});

records.all("/", (c) => {
  c.header("Allow", "GET, POST");
  throw errors.methodNotAllowed(
    `method ${c.req.method} not allowed on this route`,
    "the records collection endpoint supports GET (list) and POST (create) — see SPEC.md#http-api-v1",
  );
});

// Catch-all for paths deeper than /:recordKey (e.g. an extra segment). Hits
// before the participants-human wildcard middleware can claim it.
records.all("/*", () => {
  throw errors.notFound();
});

export default records;
