import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import {
  createSessionSchema,
  listSessionsQuerySchema,
  mintParticipantSchema,
} from "@paneui/core";
import type { Config } from "../../config.js";
import { appendSystemEvent } from "../../core/events.js";
import {
  generateSessionId,
  generateAgentParticipantToken,
  generateHumanParticipantToken,
  hashKey,
  keyPrefix,
} from "../../keys.js";
import { dualAuth, requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import { issueTicket, TICKET_TTL_MS } from "../../ws/ticket.js";
import {
  assertSchemaWithinLimits,
  assertValidInputSchema,
  validateSchemaShape,
  validateInputData,
  validateSessionTitle,
} from "../../core/validation.js";
import {
  assertBlobsAccessibleByAgent,
  collectBlobRefs,
} from "../../blobs/ref-access.js";
import { assertSafeWebhookUrl } from "../ssrf.js";
import { encryptSecret } from "../../crypto.js";
import { recordSessionCreated } from "../../telemetry/metrics.js";
import type { EventSchema } from "../../types.js";

const sessions = new Hono<AuthEnv>();

// `createSessionSchema` (request shape for POST /v1/sessions) is the single
// source of truth in @paneui/core/schemas — the relay imports it so the
// server-side validator and the client-facing types can never drift. See
// packages/core/src/schemas.ts.

function publicWsUrl(config: Config): string {
  const u = new URL(config.publicUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/$/, "");
}

// Default page size for GET /v1/sessions. The upper bound (200) lives on
// `listSessionsQuerySchema` in @paneui/core so the validation site is the
// single source of truth.
const LIST_DEFAULT_LIMIT = 50;

// Opaque cursor for GET /v1/sessions. We encode `{ created_at, id }` as
// base64url JSON so the ordering tuple is captured verbatim and a row can be
// found again across pages without depending on a wall-clock comparison.
// Stability: ordering is `(createdAt DESC, id DESC)`, so the next page is
// "rows strictly before (cursor.createdAt, cursor.id)" in that ordering.
interface ListCursor {
  created_at: string;
  id: string;
}

function encodeCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(s: string): ListCursor | null {
  try {
    const decoded = Buffer.from(s, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as ListCursor).created_at !== "string" ||
      typeof (parsed as ListCursor).id !== "string"
    ) {
      return null;
    }
    const ts = new Date((parsed as ListCursor).created_at);
    if (Number.isNaN(ts.getTime())) return null;
    return parsed as ListCursor;
  } catch {
    return null;
  }
}

// GET /v1/sessions — list the calling agent's sessions.
//
// Lean, agent-scoped. NO secrets in the response: no participant token
// plaintext (impossible — only the hash is stored), no callback_url (may
// contain a webhook secret in the path), no metadata / input_data (large
// and potentially sensitive — fetch via GET /v1/sessions/:id when needed).
//
// Mounted before GET /:id; Hono matches by literal path, so the order here
// is for readability, not correctness.
sessions.get("/", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");

  const parsed = listSessionsQuerySchema.safeParse({
    status: c.req.query("status"),
    limit:
      c.req.query("limit") !== undefined
        ? Number(c.req.query("limit"))
        : undefined,
    cursor: c.req.query("cursor"),
    artifact_id: c.req.query("artifact_id"),
  });
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid query",
      parsed.error.flatten(),
      "status must be one of open|closed|all; limit must be 1..200; cursor must be a non-empty opaque token returned by a previous page; artifact_id must be a non-empty string",
    );
  }
  const status = parsed.data.status ?? "open";
  const limit = parsed.data.limit ?? LIST_DEFAULT_LIMIT;

  let cursor: ListCursor | null = null;
  if (parsed.data.cursor !== undefined) {
    cursor = decodeCursor(parsed.data.cursor);
    if (cursor === null) {
      throw errors.invalidRequest(
        "invalid cursor",
        undefined,
        "the cursor must be the opaque `next_cursor` value returned by a previous page; do not construct it by hand",
      );
    }
  }

  // Status projection. The session column may say "open" while expiresAt is
  // in the past — GET /v1/sessions/:id projects that as "closed" at read
  // time, and the list must do the same to stay consistent. We translate the
  // effective-status filter into a SQL predicate over (status, expiresAt).
  const now = new Date();
  const statusWhere = ((): Prisma.SessionWhereInput => {
    if (status === "all") return {};
    if (status === "open") {
      // Effective open = column open AND not yet expired.
      return { status: "open", expiresAt: { gt: now } };
    }
    // Effective closed = column closed OR expired.
    return {
      OR: [{ status: "closed" }, { expiresAt: { lte: now } }],
    };
  })();

  // artifact_id filter: match the artifact_version.artifactId (the head's id).
  // Only the caller's own artifacts can match — Session.agentId filter already
  // restricts that, but the artifact filter is exposed as a convenience.
  const artifactWhere: Prisma.SessionWhereInput =
    parsed.data.artifact_id !== undefined
      ? { artifactVersion: { artifactId: parsed.data.artifact_id } }
      : {};

  // Cursor predicate. Ordering is (createdAt DESC, id DESC); "next page" is
  // rows strictly before the cursor row in that tuple ordering.
  const cursorWhere: Prisma.SessionWhereInput =
    cursor !== null
      ? {
          OR: [
            { createdAt: { lt: new Date(cursor.created_at) } },
            {
              createdAt: new Date(cursor.created_at),
              id: { lt: cursor.id },
            },
          ],
        }
      : {};

  const rows = await prisma.session.findMany({
    where: {
      agentId: me.id,
      ...statusWhere,
      ...artifactWhere,
      ...cursorWhere,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: {
      artifactVersion: {
        select: {
          artifactId: true,
          version: true,
          // The Artifact head carries `name`/`slug` — null for anonymous
          // (inline) artifacts. `artifact_id` is returned as null for those
          // so the agent can distinguish "no reusable artifact behind this"
          // from "the artifact id I lost track of".
          artifact: { select: { name: true, slug: true } },
        },
      },
      // Don't pull full participant rows for the list — agents with many
      // sessions × many humans would pay the bandwidth on every list call.
      // Just count active humans so the row shows occupancy at a glance;
      // for the full participant array (with participant_id + token_prefix
      // + revoked_at), call `GET /v1/sessions/:id/participants`.
      _count: {
        select: {
          participants: { where: { kind: "human", revokedAt: null } },
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const items = page.map((s) => {
    const isExpired = s.expiresAt.getTime() < Date.now();
    const isAnonymous =
      s.artifactVersion.artifact.name === null &&
      s.artifactVersion.artifact.slug === null;
    return {
      session_id: s.id,
      title: s.title,
      status: (isExpired ? "closed" : s.status) as "open" | "closed",
      artifact_id: isAnonymous ? null : s.artifactVersion.artifactId,
      artifact_version_id: s.artifactVersionId,
      artifact_version: s.artifactVersion.version,
      // Count of active (non-revoked) human participants. For the full
      // participant array call GET /v1/sessions/:id/participants.
      active_human_participants: s._count.participants,
      created_at: s.createdAt.toISOString(),
      expires_at: s.expiresAt.toISOString(),
      has_callback: s.callbackUrl !== null,
    };
  });

  return c.json({
    items,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            created_at: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  });
});

sessions.post("/", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const agent = c.get("agent");
  const body = await c.req.json().catch(() => null);
  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }

  const { artifact, participants, ttl, metadata, callback, input_data, title } =
    parsed.data;

  const requestedHumans = participants?.humans ?? 1;
  if (requestedHumans > config.MAX_PARTICIPANTS_PER_SESSION) {
    throw errors.invalidRequest(
      `participants.humans must be <= ${config.MAX_PARTICIPANTS_PER_SESSION}`,
    );
  }

  if (callback) {
    await assertSafeWebhookUrl(callback.url);
  }

  // Resolve (reference form) or create (inline form) the artifact version this
  // session pins. Either path ends with a concrete artifact_version_id.
  let artifactVersionId: string;
  let artifactId: string;
  // The pinned version's input_schema, if it declares one. Null = the version
  // has no input contract, so `input_data` (if any) is accepted unvalidated.
  let inputSchema: unknown = null;
  // The artifact head's `name`, if any. Used as the title fallback for the
  // reference form below. Null for inline (anonymous) artifacts.
  let artifactName: string | null = null;

  if ("id" in artifact && artifact.id !== undefined) {
    // Reference form — instance an existing named artifact owned by this agent.
    // `artifact.id` accepts the artifact id or its slug.
    const head = await prisma.artifact.findFirst({
      where: {
        ownerId: agent.id,
        OR: [{ id: artifact.id }, { slug: artifact.id }],
      },
    });
    if (!head) throw errors.artifactNotFound();
    const wantVersion = artifact.version ?? head.latestVersion;
    const version = await prisma.artifactVersion.findUnique({
      where: {
        artifactId_version: { artifactId: head.id, version: wantVersion },
      },
    });
    if (!version) throw errors.artifactVersionNotFound();
    artifactVersionId = version.id;
    artifactId = head.id;
    inputSchema = version.inputSchema;
    artifactName = head.name;
  } else {
    // Inline form — a one-off UI. Validate the inline content, then
    // transparently create an anonymous artifact (name/slug null) + v1.
    const inline = artifact as {
      source: string;
      type: "html-inline" | "html-ref";
      event_schema?: unknown;
      input_schema?: unknown;
    };
    if (Buffer.byteLength(inline.source, "utf8") > config.MAX_ARTIFACT_BYTES) {
      throw errors.payloadTooLarge();
    }
    if (inline.type === "html-ref") {
      // v1 does not serve html-ref artifacts — the shell would render a blank
      // iframe with no error (see issue #24). Reject at create time.
      throw errors.invalidRequest(
        "artifact.type 'html-ref' is not supported in this release",
        undefined,
        "use artifact.type 'html-inline' and pass the artifact HTML in artifact.source",
      );
    }
    // An absent event_schema = a view-only one-off (a report/dashboard the
    // human only views). Skip schema-shape validation and persist null; the
    // session then rejects every page/agent emit. A present-but-malformed
    // schema is still rejected as today.
    let eventSchema: EventSchema | null = null;
    if (inline.event_schema !== undefined) {
      assertSchemaWithinLimits(inline.event_schema, {
        maxBytes: config.MAX_SCHEMA_BYTES,
        maxDepth: config.MAX_SCHEMA_DEPTH,
      });
      eventSchema = validateSchemaShape(inline.event_schema);
    }
    // An absent input_schema = no input contract; the session accepts any
    // input_data (or none) and the participant blob-download bridge has no
    // walkable sites for `format: pane-blob-id` in input_data. When present,
    // the schema is compiled with the same Ajv pipeline used by named
    // artifacts (`assertValidInputSchema`), persisted on the auto-created
    // artifact version below, and surfaced to the downstream input_data
    // validator + blob-ref access check via the outer `inputSchema` var.
    // Before this branch existed, inline sessions hardcoded inputSchema to
    // Prisma.JsonNull — making blob refs in input_data silently unreachable
    // even when the agent owned the blob (#208).
    if (inline.input_schema !== undefined) {
      assertSchemaWithinLimits(inline.input_schema, {
        maxBytes: config.MAX_SCHEMA_BYTES,
        maxDepth: config.MAX_SCHEMA_DEPTH,
      });
      assertValidInputSchema(inline.input_schema);
      inputSchema = inline.input_schema;
    }

    const created = await prisma.$transaction(async (tx) => {
      const head = await tx.artifact.create({
        data: { ownerId: agent.id, name: null, slug: null, latestVersion: 1 },
      });
      const version = await tx.artifactVersion.create({
        data: {
          artifactId: head.id,
          version: 1,
          artifactType: inline.type,
          artifactSource: inline.source,
          eventSchema:
            eventSchema !== null
              ? (eventSchema as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          inputSchema:
            inline.input_schema !== undefined
              ? (inline.input_schema as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        },
      });
      return { headId: head.id, versionId: version.id };
    });
    artifactVersionId = created.versionId;
    artifactId = created.headId;
  }

  // Resolve the per-session tab title. The relay treats title as required at
  // the storage layer (Session.title is NOT NULL), but offers one ergonomic
  // fallback: a reference-form session against a named artifact picks up the
  // artifact's `name`. Inline form has no name to fall back to and must carry
  // `title` explicitly. Both paths funnel through validateSessionTitle so an
  // over-long Artifact.name still surfaces a clear error rather than truncating
  // silently.
  let resolvedTitle: string;
  if (title !== undefined) {
    resolvedTitle = validateSessionTitle(title);
  } else if (artifactName !== null) {
    resolvedTitle = validateSessionTitle(artifactName);
  } else {
    throw errors.invalidRequest(
      "title is required",
      undefined,
      "pass `title` on the request body (or `--title` on `pane session create`); reference-form sessions can omit it only when the artifact has a `name`",
    );
  }

  // Phase C — input contract enforcement. If the pinned version declares an
  // `input_schema`, the session's `input_data` must satisfy it; validate now,
  // BEFORE the session row is created, so a bad request creates nothing. A
  // missing `input_data` is validated as `{}` so the schema's `required`
  // fields fail naturally. When the version has NO `input_schema` there is no
  // input contract — `input_data` (if supplied) passes through unvalidated.
  if (inputSchema != null && typeof inputSchema === "object") {
    validateInputData(inputSchema as object, input_data ?? {});

    // Follow-up B of #156 — blob-ref DB access check. After Ajv shape
    // validation passes on the input_data, walk the input_schema for
    // `format: pane-blob-id` sites and verify every referenced blob is
    // accessible to this agent. Same rationale as the event path: the
    // Ajv format is purely syntactic; DB lookups belong here.
    const refs = collectBlobRefs(inputSchema as object, input_data ?? {});
    if (refs.length > 0) {
      await assertBlobsAccessibleByAgent(prisma, agent.id, refs);
    }
  }

  // TTL behaviour:
  //   ≤ 0           → already rejected by the Zod schema (positive int).
  //   > MAX_TTL_SECONDS → REJECTED with invalid_request. The relay used to
  //                    silently clamp this, but an automated agent reading
  //                    a 24-hour `expires_at` after asking for 7 days has
  //                    no easy way to notice the discrepancy until the
  //                    session is already gone (#137). An authoritative
  //                    400 is friendlier — the agent can pass the cap-or-
  //                    lower value explicitly.
  //   in range     → used as-is.
  //   unset        → DEFAULT_TTL_SECONDS.
  const ttlRequested = ttl ?? config.DEFAULT_TTL_SECONDS;
  if (ttlRequested > config.MAX_TTL_SECONDS) {
    throw errors.invalidRequest(
      `ttl ${ttlRequested}s exceeds this relay's MAX_TTL_SECONDS (${config.MAX_TTL_SECONDS}s)`,
      { ttl: ttlRequested, max: config.MAX_TTL_SECONDS },
      `pass a ttl <= ${config.MAX_TTL_SECONDS} (in seconds), or omit --ttl to get the default of ${config.DEFAULT_TTL_SECONDS}s`,
    );
  }
  const ttlSeconds = Math.max(1, ttlRequested);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // Per-agent session cap: bound how many open sessions a single agent can
  // hold so a compromised/abusive key cannot exhaust storage. Closed/expired
  // sessions do not count — they are reclaimed by the TTL sweeper.
  // This is a count-then-create check, so it is a SOFT cap — concurrent
  // POST /v1/sessions from one agent can race past it and overshoot by
  // roughly the number of inflight requests. Acceptable: the cap bounds
  // abuse to ~N, not an exact count, and the limit is deliberately generous.
  if (config.MAX_SESSIONS_PER_AGENT > 0) {
    const openCount = await prisma.session.count({
      where: { agentId: agent.id, status: "open" },
    });
    if (openCount >= config.MAX_SESSIONS_PER_AGENT) {
      throw errors.tooManyRequests(
        `open session cap reached (max ${config.MAX_SESSIONS_PER_AGENT} per agent); close an existing session before creating a new one`,
      );
    }
  }

  const sessionId = generateSessionId();
  const humanTokens: string[] = Array.from({ length: requestedHumans }, () =>
    generateHumanParticipantToken(),
  );
  const agentToken = generateAgentParticipantToken();

  // `input_data` was validated above against the pinned version's
  // `input_schema` (when the version declares one) — it is safe to store.
  await prisma.session.create({
    data: {
      id: sessionId,
      agentId: agent.id,
      artifactVersionId,
      title: resolvedTitle,
      inputData: input_data
        ? (input_data as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      expiresAt,
      metadata: metadata
        ? (metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      callbackUrl: callback?.url ?? null,
      callbackSecretEnc: callback ? encryptSecret(callback.secret) : null,
      callbackFilter: callback?.events
        ? (callback.events as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      participants: {
        create: [
          {
            kind: "agent",
            identityId: agent.id,
            tokenHash: hashKey(agentToken),
            tokenPrefix: keyPrefix(agentToken),
          },
          ...humanTokens.map((t, i) => ({
            kind: "human" as const,
            identityId: `h_${i}`,
            tokenHash: hashKey(t),
            tokenPrefix: keyPrefix(t),
          })),
        ],
      },
    },
  });

  // Bump the artifact's last-used timestamp — search ranks by it.
  await prisma.artifact.update({
    where: { id: artifactId },
    data: { lastUsedAt: new Date() },
  });

  recordSessionCreated();

  const wsBase = publicWsUrl(config);
  return c.json(
    {
      session_id: sessionId,
      tokens: {
        humans: humanTokens,
        agent: agentToken,
      },
      urls: {
        humans: humanTokens.map((t) => `${config.publicUrl}/s/${t}`),
        agent_stream: `${wsBase}/v1/sessions/${sessionId}/stream`,
      },
      expires_at: expiresAt.toISOString(),
      title: resolvedTitle,
    },
    201,
  );
});

// Mint a short-lived, single-use WebSocket upgrade ticket.
//
// Browsers cannot set an Authorization header on `new WebSocket()`, so the WS
// URL must carry a credential as a query parameter — and a long-lived token
// there leaks into upstream proxy access logs. The browser flow is therefore:
// authenticate HERE with the real token, get a ticket, then open the WS with
// `?ticket=`. A leaked ticket is worthless (30s TTL, single-use, bound to one
// identity + session). See src/ws/ticket.ts and issue #8.
//
// Auth is DUAL — agent OR participant — exactly like the events endpoints: a
// participant holding a share-link token, or the owning agent, must both be
// able to mint a ticket for THEIR session. `dualAuth` already enforces that
// the `:id` path param matches the session the token authorizes (participant
// .sessionId === :id; agent owns the session).
sessions.post("/:id/ws-ticket", dualAuth, (c) => {
  const session = c.get("session");
  const author = c.get("author");
  if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }
  const ticket = issueTicket(author, session.id);
  return c.json(
    {
      ticket,
      expires_at: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    },
    201,
  );
});

sessions.get("/:id", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({
    where: { id },
    include: { artifactVersion: true },
  });
  if (!session || session.agentId !== me.id) throw errors.sessionNotFound();
  const isExpired = session.expiresAt.getTime() < Date.now();
  return c.json({
    session_id: session.id,
    status: isExpired ? "closed" : session.status,
    artifact_id: session.artifactVersion.artifactId,
    artifact_version_id: session.artifactVersionId,
    artifact_version: session.artifactVersion.version,
    title: session.title,
    metadata: session.metadata,
    input_data: session.inputData,
    created_at: session.createdAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
  });
});

sessions.delete("/:id", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const store = c.get("blobStore");
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.sessionNotFound();
  if (session.status === "closed") return c.body(null, 204);
  await prisma.session.update({
    where: { id },
    data: { status: "closed", expiresAt: new Date() },
  });

  // Cascade-delete session-scope blobs (issue #209). The Blob.session relation
  // declares `onDelete: Cascade`, but session delete is a SOFT close (status
  // flip + expiresAt=now), not a row delete, so the cascade never fires. Mirror
  // it explicitly: every session-scope blob still attached to this session
  // becomes status="deleted" / deletedAt=now, which is the same shape `DELETE
  // /v1/blobs/:id` produces. Capability tokens minted against these blobs stop
  // working automatically — blob-bridge.ts gates GET on
  // `status === "ready" && deletedAt === null`, so the soft-delete closes the
  // /b/<token> surface without us touching BlobToken rows.
  const liveBlobs = await prisma.blob.findMany({
    where: {
      scope: "session",
      sessionId: id,
      status: { not: "deleted" },
    },
    select: { id: true, storageKey: true },
  });
  if (liveBlobs.length > 0) {
    // Best-effort backend delete first, then mark rows. Mirrors the per-blob
    // DELETE handler: a backend failure orphans the bytes for the janitor to
    // sweep but does not block the soft-delete (the caller's intent — the
    // session is gone, the blobs are gone — is satisfied at the row level).
    if (store) {
      await Promise.all(
        liveBlobs.map((b) =>
          store.delete(b.storageKey).catch(() => {
            /* best-effort; orphan-sweep job picks up the leftover */
          }),
        ),
      );
    }
    await prisma.blob.updateMany({
      where: { id: { in: liveBlobs.map((b) => b.id) } },
      data: { status: "deleted", deletedAt: new Date() },
    });
  }

  await appendSystemEvent(prisma, id, "system.session.expired", {});
  return c.body(null, 204);
});

// GET /v1/sessions/:id/participants — list the participants on one session.
//
// Bounded by MAX_PARTICIPANTS_PER_SESSION so the response is always small
// enough to return whole (no pagination). Includes BOTH active and revoked
// rows — revoked rows carry `revoked_at !== null` and are useful for
// auditing past leaks. Owner-scoped: a cross-agent session id returns 404
// for existence-oracle parity with the other session-scoped endpoints.
sessions.get("/:id/participants", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const me = c.get("agent");

  const session = await prisma.session.findUnique({
    where: { id },
    select: { agentId: true },
  });
  if (!session || session.agentId !== me.id) throw errors.sessionNotFound();

  const participants = await prisma.participant.findMany({
    where: { sessionId: id },
    select: {
      id: true,
      kind: true,
      tokenPrefix: true,
      joinedAt: true,
      revokedAt: true,
    },
    // Agent first (kind="agent" < "human" alphabetically), then by id so
    // ordering is stable across calls.
    orderBy: [{ kind: "asc" }, { id: "asc" }],
  });

  return c.json({
    session_id: id,
    items: participants.map((p) => ({
      participant_id: p.id,
      kind: (p.kind === "agent" ? "agent" : "human") as "agent" | "human",
      token_prefix: p.tokenPrefix,
      joined_at: p.joinedAt ? p.joinedAt.toISOString() : null,
      revoked_at: p.revokedAt ? p.revokedAt.toISOString() : null,
    })),
  });
});

// POST /v1/sessions/:id/participants — mint a fresh human participant URL.
//
// The recovery primitive for the "I dropped the create response and lost the
// URL" case. The session keeps its id, event log, artifact pin, and
// createdAt; the human just gets a new entry door.
//
// One-shot contract: the plaintext token is returned exactly once. The relay
// stores only the hash. Do not log the token plaintext.
sessions.post("/:id/participants", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const id = c.req.param("id");
  const me = c.get("agent");

  const body = await c.req.json().catch(() => ({}));
  const parsed = mintParticipantSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      'the request body must be `{ "kind": "human" }`; only human participants can be minted via this endpoint',
    );
  }

  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.sessionNotFound();

  // Effectively-closed sessions cannot be revived by minting a new URL —
  // tell the agent to `pane create` instead. The check matches the
  // projection used by GET /v1/sessions/:id and the list endpoint.
  if (session.status === "closed" || session.expiresAt.getTime() < Date.now()) {
    throw errors.gone(
      "session is closed — minting a new participant on a closed session would not make it reachable",
    );
  }

  // Two counts:
  //   - `activeHumans` (revokedAt IS NULL) gates the cap. A revoked row
  //     must NOT consume a slot, otherwise the leak-containment primitive
  //     becomes a self-DoS.
  //   - `everMintedHumans` (revokedAt IS NULL OR NOT NULL) supplies a
  //     monotonic identityId index that doesn't reuse labels of revoked
  //     participants. Counting only active humans (the pre-#201 behaviour)
  //     produced `identityId` collisions after a revoke + mint cycle:
  //     two non-revoked rows could share `h_1`, and the WS handler's
  //     `findFirst({ where: { sessionId, identityId } })` would non-
  //     deterministically resolve events to whichever row sorted first.
  //
  // The (sessionId, identityId) unique constraint (#215) is the belt-and-
  // braces on this: two concurrent POSTs can both read everMintedHumans=N
  // and both try `h_${N}`, and the DB serialises the write so exactly one
  // wins on the constraint. The loser sees P2002 and the catch block below
  // re-reads the count + retries. Bounded to a small number of attempts —
  // a stuck retry loop is its own pathology.
  const token = generateHumanParticipantToken();
  let participant;
  const MAX_MINT_ATTEMPTS = 5;
  for (let attempt = 0; ; attempt++) {
    const [activeHumans, everMintedHumans] = await Promise.all([
      prisma.participant.count({
        where: { sessionId: id, kind: "human", revokedAt: null },
      }),
      prisma.participant.count({
        where: { sessionId: id, kind: "human" },
      }),
    ]);
    if (activeHumans >= config.MAX_PARTICIPANTS_PER_SESSION) {
      throw errors.conflict(
        `session already has ${activeHumans} active human participants (max ${config.MAX_PARTICIPANTS_PER_SESSION}); revoke one before minting another`,
        false,
        "revoke an existing participant first with DELETE /v1/sessions/:id/participants/:participant_id (CLI: `pane participant revoke`), then retry",
      );
    }

    try {
      participant = await prisma.participant.create({
        data: {
          sessionId: id,
          kind: "human",
          identityId: `h_${everMintedHumans}`,
          tokenHash: hashKey(token),
          tokenPrefix: keyPrefix(token),
        },
      });
      break;
    } catch (e) {
      // Prisma's known-error code for unique constraint violation is P2002.
      // The collision fingerprint differs across Prisma versions + engines:
      //   - Prisma 6 (Rust engine): `meta.target = ["session_id", "identity_id"]`
      //     on SQLite; constraint name on Postgres.
      //   - Prisma 7 (driver adapter): `meta.target` is empty / absent;
      //     the field list is carried in the message body
      //     ("Unique constraint failed on the fields: (`session_id`, `identity_id`)").
      // Match either shape so the catch survives engine churn.
      const code = (e as { code?: string } | null)?.code;
      const target = (e as { meta?: { target?: unknown } } | null)?.meta
        ?.target;
      const targetStr = Array.isArray(target)
        ? target.join(",")
        : String(target ?? "");
      const message = (e as { message?: string } | null)?.message ?? "";
      const isIdentityCollision =
        code === "P2002" &&
        (targetStr.includes("identity_id") ||
          targetStr.includes("participants_session_id_identity_id_key") ||
          message.includes("identity_id"));
      if (!isIdentityCollision || attempt >= MAX_MINT_ATTEMPTS - 1) throw e;
      // A concurrent mint won the row for `h_${everMintedHumans}`. Loop
      // back, re-read the count, and pick the next index. No backoff —
      // the next iteration's COUNT(*) already sees the winner's row.
    }
  }

  return c.json(
    {
      participant_id: participant.id,
      kind: "human" as const,
      token,
      url: `${config.publicUrl}/s/${token}`,
      created_at: new Date().toISOString(),
    },
    201,
  );
});

// DELETE /v1/sessions/:id/participants/:participant_id — revoke a single
// participant URL.
//
// Idempotent: an unknown / already-revoked / cross-session participant id
// resolves to a 204, matching the blob-token revoke contract (an agent
// retrying after a network blip must not see a different result). The
// bridge route already 404s on a revoked tokenHash (loadByToken in
// bridge/routes.ts), so this is the only HTTP change needed.
sessions.delete(
  "/:id/participants/:participant_id",
  requireAgent,
  async (c) => {
    const prisma = c.get("prisma");
    const id = c.req.param("id");
    const participantId = c.req.param("participant_id");
    const me = c.get("agent");

    // Owner check on the session first — cross-agent ids must 404 like every
    // other session-scoped endpoint (existence-oracle parity with DELETE
    // /v1/sessions/:id).
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session || session.agentId !== me.id) throw errors.sessionNotFound();

    const participant = await prisma.participant.findUnique({
      where: { id: participantId },
    });

    // Idempotent miss path: an unknown participant id, or one belonging to
    // another session, is silently a 204. This matches the agent's recovery
    // flow (revoke, possibly re-run after a partial failure) — surfacing a
    // 404 here would force the agent to handle two outcomes for what is
    // semantically the same "make sure this URL is dead" intent.
    if (!participant || participant.sessionId !== id) {
      return c.body(null, 204);
    }

    // The session's agent participant is load-bearing for the agent's own
    // WebSocket; revoking it would silently break the agent without closing
    // the session. Reject explicitly with a hint pointing at the right verb.
    if (participant.kind === "agent") {
      throw errors.invalidRequest(
        "cannot revoke the agent participant",
        undefined,
        "the agent participant carries the session's own websocket auth; to tear the session down, call DELETE /v1/sessions/:id (CLI: `pane delete <session-id>`) instead",
      );
    }

    if (participant.revokedAt !== null) {
      // Already revoked — idempotent 204.
      return c.body(null, 204);
    }

    await prisma.participant.update({
      where: { id: participant.id },
      data: { revokedAt: new Date() },
    });

    return c.body(null, 204);
  },
);

export default sessions;
