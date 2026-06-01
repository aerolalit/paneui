import { Hono } from "hono";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createPaneSchema,
  listPanesQuerySchema,
  mintParticipantSchema,
  upgradePaneSchema,
} from "@paneui/core";
import type { Config } from "../../config.js";
import { appendSystemEvent } from "../../core/events.js";
import {
  generatePaneId,
  generateAgentParticipantToken,
  generateHumanParticipantToken,
  hashKey,
  keyPrefix,
} from "../../keys.js";
import { dualAuth, requireAgent, type AuthEnv } from "../auth.js";
import { agentScope } from "../agent-scope.js";
import { errors } from "../errors.js";
import { parseIncludeDeleted, softDeleteWhere } from "../../db/soft-delete.js";
import { comparePaneSchemas } from "../../core/schema-compat.js";
import type { EventSchema } from "../../types.js";
import { log } from "../../log.js";
import { issueTicket, TICKET_TTL_MS } from "../../ws/ticket.js";
import {
  assertSchemaWithinLimits,
  assertValidInputSchema,
  validateRecordSchemaShape,
  validateSchemaShape,
  validateInputData,
  validateSessionTitle,
  validateSessionPreamble,
} from "../../core/validation.js";
import {
  assertBlobsAccessibleByAgent,
  collectBlobRefs,
} from "../../attachments/ref-access.js";
import { assertSafeWebhookUrl } from "../ssrf.js";
import { encryptSecret } from "../../crypto.js";
import { recordSessionCreated } from "../../telemetry/metrics.js";

const panes = new Hono<AuthEnv>();

// `createPaneSchema` (request shape for POST /v1/panes) is the single
// source of truth in @paneui/core/schemas — the relay imports it so the
// server-side validator and the client-facing types can never drift. See
// packages/core/src/schemas.ts.

function publicWsUrl(config: Config): string {
  const u = new URL(config.publicUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/$/, "");
}

// #283 — assert the caller may act on this pane. A pane is in scope
// for any agent claimed to the same human as its owning agent. Throws
// sessionNotFound when the pane is missing or owned by a strictly
// unrelated agent (no shared human); throws forbidden when the pane
// belongs to a different human (so the caller knows they hit a real id
// that just isn't theirs to act on, which is the debugging hint the
// issue called out).
type PaneScopeFields = { agentId: string; ownerHumanId: string | null };

// Returns the narrowed (non-null) pane so callers can continue working
// with the pane in a type-safe way without re-asserting.
async function assertPaneInScope<T extends PaneScopeFields>(
  prisma: PrismaClient,
  pane: T | null,
  me: { id: string; ownerHumanId: string | null },
): Promise<T> {
  if (!pane) throw errors.sessionNotFound();
  if (pane.agentId === me.id) return pane;
  const scope = await agentScope(prisma, me);
  if (scope.has(pane.agentId)) return pane;
  if (pane.ownerHumanId !== null) {
    throw errors.forbidden(
      "forbidden_cross_human",
      "this pane belongs to a different human's agents",
    );
  }
  throw errors.sessionNotFound();
}

// #259 — mint a kind="agent" Participant for the calling agent on a pane
// they don't yet own, so the cross-agent Phase G dedup hands back a usable
// credential. Returns the freshly-minted plaintext token, or null when the
// calling agent already has a non-revoked agent participant on this pane
// (either because they're the owning agent, or because a previous dedup
// already minted one).
//
// Token-stored-as-hash means we cannot re-emit an existing participant's
// token; the agent is responsible for keeping the value they got the first
// time. The `null` case is the "you already have access, find your old
// token" branch.
//
// Concurrency: two parallel cross-agent dedup hits from the SAME agent both
// see no existing participant and both attempt the create with
// identityId === agent.id. The `(paneId, identityId)` unique constraint
// serialises; the loser's P2002 collapses to the same "already has access"
// shape (null token), which is correct — the winner's create succeeded.
export async function mintCrossAgentParticipantIfNeeded(
  prisma: PrismaClient,
  paneId: string,
  agent: { id: string },
): Promise<{ token: string | null }> {
  const existing = await prisma.participant.findFirst({
    where: {
      paneId,
      kind: "agent",
      identityId: agent.id,
      revokedAt: null,
    },
    select: { id: true },
  });
  if (existing) return { token: null };

  const token = generateAgentParticipantToken();
  try {
    await prisma.participant.create({
      data: {
        paneId,
        kind: "agent",
        identityId: agent.id,
        tokenHash: hashKey(token),
        tokenPrefix: keyPrefix(token),
        agentId: agent.id,
      },
    });
    return { token };
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== "P2002") throw e;
    // Identity-id collision: another concurrent first-time mint from the
    // same agent won the row. Treat the same as "already has access".
    return { token: null };
  }
}

// Default page size for GET /v1/panes. The upper bound (200) lives on
// `listPanesQuerySchema` in @paneui/core so the validation site is the
// single source of truth.
const LIST_DEFAULT_LIMIT = 50;

// Opaque cursor for GET /v1/panes. We encode `{ created_at, id }` as
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

// GET /v1/panes — list the calling agent's panes.
//
// Lean, agent-scoped. NO secrets in the response: no participant token
// plaintext (impossible — only the hash is stored), no callback_url (may
// contain a webhook secret in the path), no metadata / input_data (large
// and potentially sensitive — fetch via GET /v1/panes/:id when needed).
//
// Mounted before GET /:id; Hono matches by literal path, so the order here
// is for readability, not correctness.
panes.get("/", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");

  const parsed = listPanesQuerySchema.safeParse({
    status: c.req.query("status"),
    limit:
      c.req.query("limit") !== undefined
        ? Number(c.req.query("limit"))
        : undefined,
    cursor: c.req.query("cursor"),
    template_id: c.req.query("template_id"),
  });
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid query",
      parsed.error.flatten(),
      "status must be one of open|closed|all; limit must be 1..200; cursor must be a non-empty opaque token returned by a previous page; template_id must be a non-empty string",
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

  // Status projection. The pane column may say "open" while expiresAt is
  // in the past — GET /v1/panes/:id projects that as "closed" at read
  // time, and the list must do the same to stay consistent. We translate the
  // effective-status filter into a SQL predicate over (status, expiresAt).
  const now = new Date();
  const statusWhere = ((): Prisma.PaneWhereInput => {
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

  // template_id filter: match the template_version.templateId (the head's id).
  // Only the caller's own templates can match — Pane.agentId filter already
  // restricts that, but the template filter is exposed as a convenience.
  const artifactWhere: Prisma.PaneWhereInput =
    parsed.data.template_id !== undefined
      ? { templateVersion: { templateId: parsed.data.template_id } }
      : {};

  // Cursor predicate. Ordering is (createdAt DESC, id DESC); "next page" is
  // rows strictly before the cursor row in that tuple ordering.
  const cursorWhere: Prisma.PaneWhereInput =
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

  // #283 — once an agent is claimed, the list spans every agent
  // claimed to the same human. Unclaimed agents stay self-scoped.
  const scope = await agentScope(prisma, me);
  // #305 — hide soft-deleted panes by default. Owner agents can opt-in
  // with ?include_deleted=true to see trashed rows (used by `pane trash list`
  // and the /trash UI page).
  const includeDeleted = parseIncludeDeleted(c);
  const rows = await prisma.pane.findMany({
    where: {
      agentId: { in: [...scope] },
      ...softDeleteWhere(includeDeleted),
      ...statusWhere,
      ...artifactWhere,
      ...cursorWhere,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: {
      templateVersion: {
        select: {
          templateId: true,
          version: true,
          // The Template head carries `name`/`slug` — null for anonymous
          // (inline) templates. `template_id` is returned as null for those
          // so the agent can distinguish "no reusable template behind this"
          // from "the template id I lost track of".
          template: { select: { name: true, slug: true } },
        },
      },
      // Don't pull full participant rows for the list — agents with many
      // panes × many humans would pay the bandwidth on every list call.
      // Just count active humans so the row shows occupancy at a glance;
      // for the full participant array (with participant_id + token_prefix
      // + revoked_at), call `GET /v1/panes/:id/participants`.
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
      s.templateVersion.template.name === null &&
      s.templateVersion.template.slug === null;
    return {
      pane_id: s.id,
      title: s.title,
      status: (isExpired ? "closed" : s.status) as "open" | "closed",
      template_id: isAnonymous ? null : s.templateVersion.templateId,
      template_version_id: s.templateVersionId,
      template_version: s.templateVersion.version,
      // Count of active (non-revoked) human participants. For the full
      // participant array call GET /v1/panes/:id/participants.
      active_human_participants: s._count.participants,
      created_at: s.createdAt.toISOString(),
      expires_at: s.expiresAt.toISOString(),
      // #305 — non-null iff the pane is soft-deleted (in trash). Always
      // returned so the caller can distinguish "active row" from "trashed
      // row" in a single list response when ?include_deleted=true.
      deleted_at: s.deletedAt?.toISOString() ?? null,
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

panes.post("/", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const agent = c.get("agent");
  const body = await c.req.json().catch(() => null);
  const parsed = createPaneSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }

  const {
    template,
    participants,
    ttl,
    metadata,
    callback,
    input_data,
    title,
    preamble,
    context_key,
  } = parsed.data;

  const resolvedPreamble = validateSessionPreamble(preamble);

  const requestedHumans = participants?.humans ?? 1;
  if (requestedHumans > config.MAX_PARTICIPANTS_PER_PANE) {
    throw errors.invalidRequest(
      `participants.humans must be <= ${config.MAX_PARTICIPANTS_PER_PANE}`,
    );
  }

  if (callback) {
    await assertSafeWebhookUrl(callback.url);
  }

  // Resolve (reference form) or create (inline form) the template version this
  // pane pins. Either path ends with a concrete template_version_id.
  let templateVersionId: string;
  let templateId: string;
  // The pinned version's input_schema, if it declares one. Null = the version
  // has no input contract, so `input_data` (if any) is accepted unvalidated.
  let inputSchema: unknown = null;
  // The template head's `name`, if any. Used as the title fallback for the
  // reference form below. Null for inline (anonymous) templates.
  let artifactName: string | null = null;

  if ("id" in template && template.id !== undefined) {
    // Reference form — instance an existing named template owned by this agent.
    // `template.id` accepts the template id or its slug.
    const head = await prisma.template.findFirst({
      where: {
        ownerId: agent.id,
        OR: [{ id: template.id }, { slug: template.id }],
      },
    });
    if (!head) throw errors.artifactNotFound();
    const wantVersion = template.version ?? head.latestVersion;
    const version = await prisma.templateVersion.findUnique({
      where: {
        templateId_version: { templateId: head.id, version: wantVersion },
      },
    });
    if (!version) throw errors.artifactVersionNotFound();
    templateVersionId = version.id;
    templateId = head.id;
    inputSchema = version.inputSchema;
    artifactName = head.name;
  } else {
    // Inline form — a one-off UI. Validate the inline content, then
    // transparently create an anonymous template (name/slug null) + v1.
    const inline = template as {
      source: string;
      type: "html-inline" | "html-ref";
      event_schema?: unknown;
      input_schema?: unknown;
      record_schema?: unknown;
    };
    if (Buffer.byteLength(inline.source, "utf8") > config.MAX_ARTIFACT_BYTES) {
      throw errors.payloadTooLarge();
    }
    if (inline.type === "html-ref") {
      // v1 does not serve html-ref templates — the shell would render a blank
      // iframe with no error (see issue #24). Reject at create time.
      throw errors.invalidRequest(
        "template.type 'html-ref' is not supported in this release",
        undefined,
        "use template.type 'html-inline' and pass the template HTML in template.source",
      );
    }
    // An absent event_schema = a view-only one-off (a report/dashboard the
    // human only views). Skip schema-shape validation and persist null; the
    // pane then rejects every page/agent emit. A present-but-malformed
    // schema is still rejected as today.
    let eventSchema: EventSchema | null = null;
    if (inline.event_schema !== undefined) {
      assertSchemaWithinLimits(inline.event_schema, {
        maxBytes: config.MAX_SCHEMA_BYTES,
        maxDepth: config.MAX_SCHEMA_DEPTH,
      });
      eventSchema = validateSchemaShape(inline.event_schema);
    }
    // An absent input_schema = no input contract; the pane accepts any
    // input_data (or none) and the participant attachment-download bridge has no
    // walkable sites for `format: pane-attachment-id` in input_data. When present,
    // the schema is compiled with the same Ajv pipeline used by named
    // templates (`assertValidInputSchema`), persisted on the auto-created
    // template version below, and surfaced to the downstream input_data
    // validator + attachment-ref access check via the outer `inputSchema` var.
    // Before this branch existed, inline panes hardcoded inputSchema to
    // Prisma.JsonNull — making attachment refs in input_data silently unreachable
    // even when the agent owned the attachment (#208).
    if (inline.input_schema !== undefined) {
      assertSchemaWithinLimits(inline.input_schema, {
        maxBytes: config.MAX_SCHEMA_BYTES,
        maxDepth: config.MAX_SCHEMA_DEPTH,
      });
      assertValidInputSchema(inline.input_schema);
      inputSchema = inline.input_schema;
    }
    // #289 — validate record_schema shape on inline templates. Validation-only
    // for this PR (persistence lands once #288 adds the Prisma column); a 400
    // here panes a malformed agent-supplied record_schema instead of
    // silently dropping it.
    if (inline.record_schema !== undefined) {
      assertSchemaWithinLimits(inline.record_schema, {
        maxBytes: config.MAX_SCHEMA_BYTES,
        maxDepth: config.MAX_SCHEMA_DEPTH,
      });
      validateRecordSchemaShape(inline.record_schema);
    }

    const created = await prisma.$transaction(async (tx) => {
      const head = await tx.template.create({
        data: { ownerId: agent.id, name: null, slug: null, latestVersion: 1 },
      });
      const version = await tx.templateVersion.create({
        data: {
          templateId: head.id,
          version: 1,
          templateType: inline.type,
          templateSource: inline.source,
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
    templateVersionId = created.versionId;
    templateId = created.headId;
  }

  // Resolve the per-pane tab title. The relay treats title as required at
  // the storage layer (Pane.title is NOT NULL), but offers one ergonomic
  // fallback: a reference-form pane against a named template picks up the
  // template's `name`. Inline form has no name to fall back to and must carry
  // `title` explicitly. Both paths funnel through validateSessionTitle so an
  // over-long Template.name still panes a clear error rather than truncating
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
      "pass `title` on the request body (or `--title` on `pane pane create`); reference-form panes can omit it only when the template has a `name`",
    );
  }

  // Phase C — input contract enforcement. If the pinned version declares an
  // `input_schema`, the pane's `input_data` must satisfy it; validate now,
  // BEFORE the pane row is created, so a bad request creates nothing. A
  // missing `input_data` is validated as `{}` so the schema's `required`
  // fields fail naturally. When the version has NO `input_schema` there is no
  // input contract — `input_data` (if supplied) passes through unvalidated.
  if (inputSchema != null && typeof inputSchema === "object") {
    validateInputData(inputSchema as object, input_data ?? {});

    // Follow-up B of #156 — attachment-ref DB access check. After Ajv shape
    // validation passes on the input_data, walk the input_schema for
    // `format: pane-attachment-id` sites and verify every referenced attachment is
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
  //                    pane is already gone (#137). An authoritative
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

  // Per-agent pane cap: bound how many open panes a single agent can
  // hold so a compromised/abusive key cannot exhaust storage. Closed/expired
  // panes do not count — they are reclaimed by the TTL sweeper.
  // This is a count-then-create check, so it is a SOFT cap — concurrent
  // POST /v1/panes from one agent can race past it and overshoot by
  // roughly the number of inflight requests. Acceptable: the cap bounds
  // abuse to ~N, not an exact count, and the limit is deliberately generous.
  if (config.MAX_PANES_PER_AGENT > 0) {
    const openCount = await prisma.pane.count({
      where: { agentId: agent.id, status: "open" },
    });
    if (openCount >= config.MAX_PANES_PER_AGENT) {
      throw errors.tooManyRequests(
        `open pane cap reached (max ${config.MAX_PANES_PER_AGENT} per agent); close an existing pane before creating a new one`,
      );
    }
  }

  // Phase G — contextKey dedup. When the caller supplies a context_key and
  // the calling agent is claimed by a human, look up an existing pane
  // owned by that human for the same (templateVersionId, ownerHumanId,
  // contextKey). If found, return it instead of creating a new one. The
  // unique index defined in Phase A's schema enforces this at the DB
  // layer too (concurrent creates would lose the race to P2002 and we
  // retry by re-reading).
  //
  // Standalone agents (no ownerHumanId) skip the dedup — they're the
  // pre-Phase-A path where every create made a fresh row.
  const dedupKey = context_key ?? null;
  const ownerHumanId = agent.ownerHumanId;
  if (dedupKey && ownerHumanId) {
    // #305 — a soft-deleted pane must not satisfy contextKey dedup.
    // Re-creating a "same context_key" pane after the previous one is
    // trashed should produce a fresh row, otherwise the caller would be
    // handed a pane_id that 410s on every mutation.
    const existing = await prisma.pane.findFirst({
      where: {
        templateVersionId,
        ownerHumanId,
        contextKey: dedupKey,
        deletedAt: null,
      },
      include: {
        participants: {
          where: { revokedAt: null },
        },
      },
    });
    if (existing) {
      // Cross-agent dedup (#259): if the calling agent isn't yet a
      // participant on the matched pane, mint a fresh kind="agent"
      // Participant for them and return its token. Without this the
      // dedup branch hands the caller a pane_id they have no
      // credential to use — the dedup contract was leaking under the
      // realistic "human owns A and B, both call create with the same
      // context_key" case.
      //
      // Same-agent dedup is unchanged: the owning agent already has a
      // kind="agent" Participant from the original create, the helper
      // returns null, the response keeps the existing { agent: null }
      // shape and the agent uses the token they got at first create.
      const { token: dedupAgentToken } =
        await mintCrossAgentParticipantIfNeeded(prisma, existing.id, agent);
      // Human-side participant tokens are stored hashed and cannot be
      // re-emitted; the caller lists them via /v1/panes/:id/participants
      // and mints fresh ones with /v1/panes/:id/participants when needed.
      const existingHumanCount = existing.participants.filter(
        (p) => p.kind === "human",
      ).length;
      const wsBase = publicWsUrl(config);
      return c.json(
        {
          pane_id: existing.id,
          created: false,
          tokens: { humans: [], agent: dedupAgentToken },
          urls: {
            humans: [],
            agent_stream: `${wsBase}/v1/panes/${existing.id}/stream`,
          },
          expires_at: existing.expiresAt.toISOString(),
          title: existing.title,
          context_key: existing.contextKey,
          active_human_participants: existingHumanCount,
        },
        200,
      );
    }
  }

  const paneId = generatePaneId();
  const humanTokens: string[] = Array.from({ length: requestedHumans }, () =>
    generateHumanParticipantToken(),
  );
  const agentToken = generateAgentParticipantToken();

  // `input_data` was validated above against the pinned version's
  // `input_schema` (when the version declares one) — it is safe to store.
  // For human-owned panes (claimed agent), set ownerHumanId so dedup
  // and the human-side catalogs (my-panes, …) see this row.
  //
  // P2002 catch on the create: the `panes_template_version_id_owner_human_id_context_key_key` unique index
  // (`@@unique([templateVersionId, ownerHumanId, contextKey])` on Pane)
  // is the load-bearing guarantee here — two concurrent creates with the
  // same dedup key both pass the `findFirst` above and race into `create`;
  // the loser hits P2002 and we resolve to the winner's row, returning the
  // same dedup-hit shape the pre-check would have. Without this the second
  // caller bubbles a 500 and the dedup contract leaks under concurrency.
  try {
    await prisma.pane.create({
      data: {
        id: paneId,
        agentId: agent.id,
        ownerHumanId,
        contextKey: dedupKey,
        creatorKind: "agent",
        creatorId: agent.id,
        templateVersionId,
        title: resolvedTitle,
        preamble: resolvedPreamble,
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
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== "P2002" || !dedupKey || !ownerHumanId) {
      throw e;
    }
    // Concurrent dedup race — the winner's row exists. Re-read and return
    // the same shape as the pre-check above.
    // #305 — only LIVE rows can satisfy dedup. A soft-deleted winner means
    // the trashed row's `(templateVersionId, ownerHumanId, contextKey)` is
    // still occupying the unique index; the unique index is not partial on
    // `deletedAt`, so re-creates collide until the hard-delete sweeper
    // reclaims the row. Surface this as `conflict` with a restore-or-wait
    // hint, instead of handing back the trashed pane_id as a success.
    const winner = await prisma.pane.findFirst({
      where: {
        templateVersionId,
        ownerHumanId,
        contextKey: dedupKey,
        deletedAt: null,
      },
      include: {
        participants: { where: { revokedAt: null } },
      },
    });
    if (!winner) {
      // Either the winner was hard-deleted between P2002 and re-read (rare,
      // surfaces the original error) OR a soft-deleted row is occupying
      // the unique slot. Distinguish the two so the caller gets a useful
      // hint rather than the raw Prisma error.
      const trashed = await prisma.pane.findFirst({
        where: {
          templateVersionId,
          ownerHumanId,
          contextKey: dedupKey,
          deletedAt: { not: null },
        },
        select: { id: true },
      });
      if (trashed) {
        throw errors.conflict(
          `a soft-deleted pane with the same context_key is occupying the dedup slot`,
          false,
          `restore the trashed pane (POST /v1/trash/panes/${trashed.id}/restore) or wait for the hard-delete sweeper to reclaim it before retrying with this context_key`,
        );
      }
      throw e;
    }
    // #259 — same cross-agent participant mint as the pre-check dedup
    // branch above. The retry path can also be the FIRST time a peer
    // agent sees this pane (their create lost the create race AND the
    // matched pane belongs to a different agent owned by the same
    // human), so we run the same helper here. See its doc-comment for
    // the same-agent vs cross-agent behaviour split.
    const { token: dedupAgentToken } = await mintCrossAgentParticipantIfNeeded(
      prisma,
      winner.id,
      agent,
    );
    const winnerHumanCount = winner.participants.filter(
      (p) => p.kind === "human",
    ).length;
    const wsBase = publicWsUrl(config);
    return c.json(
      {
        pane_id: winner.id,
        created: false,
        tokens: { humans: [], agent: dedupAgentToken },
        urls: {
          humans: [],
          agent_stream: `${wsBase}/v1/panes/${winner.id}/stream`,
        },
        expires_at: winner.expiresAt.toISOString(),
        title: winner.title,
        context_key: winner.contextKey,
        active_human_participants: winnerHumanCount,
      },
      200,
    );
  }

  // Bump the template's last-used timestamp — search ranks by it.
  await prisma.template.update({
    where: { id: templateId },
    data: { lastUsedAt: new Date() },
  });

  recordSessionCreated();

  const wsBase = publicWsUrl(config);
  return c.json(
    {
      pane_id: paneId,
      created: true,
      tokens: {
        humans: humanTokens,
        agent: agentToken,
      },
      urls: {
        humans: humanTokens.map((t) => `${config.publicUrl}/s/${t}`),
        agent_stream: `${wsBase}/v1/panes/${paneId}/stream`,
      },
      expires_at: expiresAt.toISOString(),
      title: resolvedTitle,
      context_key: dedupKey,
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
// identity + pane). See src/ws/ticket.ts and issue #8.
//
// Auth is DUAL — agent OR participant — exactly like the events endpoints: a
// participant holding a share-link token, or the owning agent, must both be
// able to mint a ticket for THEIR pane. `dualAuth` already enforces that
// the `:id` path param matches the pane the token authorizes (participant
// .paneId === :id; agent owns the pane).
panes.post("/:id/ws-ticket", dualAuth, (c) => {
  const pane = c.get("pane");
  const author = c.get("author");
  // #305 — refuse WS ticket for soft-deleted panes. A trashed pane is
  // read-only until restored; minting a ticket would let the holder push new
  // events into a row destined for hard-delete.
  if (pane.deletedAt !== null) throw errors.softDeleted("pane");
  if (pane.status !== "open" || pane.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }
  const ticket = issueTicket(author, pane.id);
  return c.json(
    {
      ticket,
      expires_at: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    },
    201,
  );
});

panes.get("/:id", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const me = c.get("agent");
  const paneRaw = await prisma.pane.findUnique({
    where: { id },
    include: { templateVersion: true },
  });
  const pane = await assertPaneInScope(prisma, paneRaw, me);
  const isExpired = pane.expiresAt.getTime() < Date.now();
  return c.json({
    pane_id: pane.id,
    status: isExpired ? "closed" : pane.status,
    template_id: pane.templateVersion.templateId,
    template_version_id: pane.templateVersionId,
    template_version: pane.templateVersion.version,
    title: pane.title,
    metadata: pane.metadata,
    input_data: pane.inputData,
    created_at: pane.createdAt.toISOString(),
    expires_at: pane.expiresAt.toISOString(),
    // #305 — GET /:id always returns soft-deleted panes (the id is
    // unguessable, so exposure is not a leak); `deleted_at` lets the caller
    // see "this row is in trash, restore it before mutating". Mutations
    // (upgrade/ws-ticket/participants) still 410 — see softDeleted error.
    deleted_at: pane.deletedAt?.toISOString() ?? null,
  });
});

// POST /v1/panes/:id/upgrade — re-pin a live pane to a newer (or
// other) version of the same template (#267). The schema-compat gate (see
// src/core/schema-compat.ts) refuses by default when the target schema
// narrows the pane's current one; compat="force" overrides.
//
// Events on disk are never rewritten — #268 stamps the version on each
// event at write time, so a downstream polymorphic-render can read old
// events under their original schema even after the upgrade.
panes.post("/:id/upgrade", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const me = c.get("agent");

  // Body — accept an empty body and apply defaults (latest version, strict).
  let body;
  try {
    const raw = await c.req.json().catch(() => ({}));
    body = upgradePaneSchema.parse(raw);
  } catch (e) {
    throw errors.invalidRequest(
      "invalid body",
      e,
      `the request body must be \`{ "template_version"?: number, "compat"?: "strict" | "force" }\``,
    );
  }
  const compat = body.compat ?? "strict";

  // Pane — must exist, must be owned by the calling agent (or a
  // same-human sibling agent — #283), must be live.
  const paneRaw = await prisma.pane.findUnique({
    where: { id },
    include: { templateVersion: { include: { template: true } } },
  });
  const pane = await assertPaneInScope(prisma, paneRaw, me);
  // #305 — refuse mutation on a soft-deleted (trashed) pane. Distinct from
  // the closed/expired check below: closed panes 410 with "create a new
  // one", trashed panes 410 with "restore from trash first" so the caller
  // knows the row is recoverable.
  if (pane.deletedAt !== null) throw errors.softDeleted("pane");
  if (pane.status === "closed" || pane.expiresAt.getTime() < Date.now()) {
    throw errors.gone("pane is closed — upgrading a closed pane has no effect");
  }

  // Target version. Defaults to the template head's latestVersion. Must
  // belong to the SAME template (the route doesn't support cross-template
  // re-pointing — that'd be a different pane, conceptually).
  const targetVersionNum =
    body.template_version ?? pane.templateVersion.template.latestVersion;
  const targetVersion = await prisma.templateVersion.findUnique({
    where: {
      templateId_version: {
        templateId: pane.templateVersion.templateId,
        version: targetVersionNum,
      },
    },
  });
  if (!targetVersion) {
    throw errors.artifactVersionNotFound();
  }

  // No-op: the pane is already on the target version. Return the
  // current state with upgraded=false; idempotent retry-safe.
  if (targetVersion.id === pane.templateVersionId) {
    return c.json({
      pane_id: id,
      template_version_id: pane.templateVersionId,
      template_version: pane.templateVersion.version,
      upgraded: false,
      breaks: [],
      compat,
    });
  }

  // Compat gate. PR A's library does the schema diff; this route just
  // decides what to do with the result.
  const breaks = comparePaneSchemas({
    oldEventSchema: pane.templateVersion
      .eventSchema as unknown as EventSchema | null,
    newEventSchema: targetVersion.eventSchema as unknown as EventSchema | null,
    oldInputSchema: pane.templateVersion.inputSchema as Record<
      string,
      unknown
    > | null,
    newInputSchema: targetVersion.inputSchema as Record<string, unknown> | null,
    // #290 — record-schema diff. Reaches into the recordSchema column added
    // by #288; a missing column reads as null, which compareRecordSchema
    // treats as additive-only.
    oldRecordSchema: pane.templateVersion.recordSchema as Record<
      string,
      unknown
    > | null,
    newRecordSchema: targetVersion.recordSchema as Record<
      string,
      unknown
    > | null,
  });
  if (breaks.length > 0 && compat === "strict") {
    throw errors.schemaIncompatibleUpgrade(breaks);
  }

  // Apply the re-pin. Events on disk are unchanged — they keep their
  // original templateVersionId stamp (#268).
  await prisma.pane.update({
    where: { id },
    data: { templateVersionId: targetVersion.id },
  });

  // Audit-log the upgrade as a system event. The full breaks list goes
  // into the event payload (even on strict success, where breaks=[])
  // so an operator reviewing the pane log can see exactly what
  // changed. Logged at warn level on a force-with-breaks for the
  // operator's monitor to pick up.
  if (compat === "force" && breaks.length > 0) {
    log.warn("pane upgrade with compat=force skipped schema gate", {
      paneId: id,
      agentId: me.id,
      fromVersion: pane.templateVersion.version,
      toVersion: targetVersion.version,
      breakCount: breaks.length,
    });
  }
  await appendSystemEvent(prisma, id, "system.template.updated", {
    from_version_id: pane.templateVersionId,
    from_version: pane.templateVersion.version,
    to_version_id: targetVersion.id,
    to_version: targetVersion.version,
    compat,
    breaks,
  });

  return c.json({
    pane_id: id,
    template_version_id: targetVersion.id,
    template_version: targetVersion.version,
    upgraded: true,
    breaks,
    compat,
  });
});

panes.delete("/:id", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const store = c.get("blobStore");
  const id = c.req.param("id");
  const me = c.get("agent");
  const paneRaw = await prisma.pane.findUnique({ where: { id } });
  const pane = await assertPaneInScope(prisma, paneRaw, me);
  // #305 — already in trash: idempotent no-op. The TTL sweeper (#303) flips
  // expired panes to soft-deleted; DELETEing one again should not 410 since
  // the caller's intent ("close this pane") is already satisfied.
  if (pane.deletedAt !== null) return c.body(null, 204);
  if (pane.status === "closed") return c.body(null, 204);
  await prisma.pane.update({
    where: { id },
    data: { status: "closed", expiresAt: new Date() },
  });

  // Cascade-delete pane-scope attachments (issue #209). The Blob.pane relation
  // declares `onDelete: Cascade`, but pane delete is a SOFT close (status
  // flip + expiresAt=now), not a row delete, so the cascade never fires. Mirror
  // it explicitly: every pane-scope attachment still attached to this pane
  // becomes status="deleted" / deletedAt=now, which is the same shape `DELETE
  // /v1/attachments/:id` produces. Capability tokens minted against these attachments stop
  // working automatically — attachment-bridge.ts gates GET on
  // `status === "ready" && deletedAt === null`, so the soft-delete closes the
  // /b/<token> pane without us touching AttachmentToken rows.
  const liveBlobs = await prisma.attachment.findMany({
    where: {
      scope: "pane",
      paneId: id,
      status: { not: "deleted" },
    },
    select: { id: true, storageKey: true },
  });
  if (liveBlobs.length > 0) {
    // Best-effort backend delete first, then mark rows. Mirrors the per-attachment
    // DELETE handler: a backend failure orphans the bytes for the janitor to
    // sweep but does not block the soft-delete (the caller's intent — the
    // pane is gone, the attachments are gone — is satisfied at the row level).
    if (store) {
      await Promise.all(
        liveBlobs.map((b) =>
          store.delete(b.storageKey).catch(() => {
            /* best-effort; orphan-sweep job picks up the leftover */
          }),
        ),
      );
    }
    await prisma.attachment.updateMany({
      where: { id: { in: liveBlobs.map((b) => b.id) } },
      data: { status: "deleted", deletedAt: new Date() },
    });
  }

  await appendSystemEvent(prisma, id, "system.pane.expired", {});
  return c.body(null, 204);
});

// GET /v1/panes/:id/participants — list the participants on one pane.
//
// Bounded by MAX_PARTICIPANTS_PER_PANE so the response is always small
// enough to return whole (no pagination). Includes BOTH active and revoked
// rows — revoked rows carry `revoked_at !== null` and are useful for
// auditing past leaks. Owner-scoped: a cross-agent pane id returns 404
// for existence-oracle parity with the other pane-scoped endpoints.
panes.get("/:id/participants", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const me = c.get("agent");

  const paneRaw = await prisma.pane.findUnique({
    where: { id },
    select: { agentId: true, ownerHumanId: true },
  });
  await assertPaneInScope(prisma, paneRaw, me);

  const participants = await prisma.participant.findMany({
    where: { paneId: id },
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
    pane_id: id,
    items: participants.map((p) => ({
      participant_id: p.id,
      kind: (p.kind === "agent" ? "agent" : "human") as "agent" | "human",
      token_prefix: p.tokenPrefix,
      joined_at: p.joinedAt ? p.joinedAt.toISOString() : null,
      revoked_at: p.revokedAt ? p.revokedAt.toISOString() : null,
    })),
  });
});

// POST /v1/panes/:id/participants — mint a fresh human participant URL.
//
// The recovery primitive for the "I dropped the create response and lost the
// URL" case. The pane keeps its id, event log, template pin, and
// createdAt; the human just gets a new entry door.
//
// One-shot contract: the plaintext token is returned exactly once. The relay
// stores only the hash. Do not log the token plaintext.
panes.post("/:id/participants", requireAgent, async (c) => {
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

  const paneRaw = await prisma.pane.findUnique({ where: { id } });
  const pane = await assertPaneInScope(prisma, paneRaw, me);

  // #305 — refuse mutation on a soft-deleted (trashed) pane.
  if (pane.deletedAt !== null) throw errors.softDeleted("pane");

  // Effectively-closed panes cannot be revived by minting a new URL —
  // tell the agent to `pane create` instead. The check matches the
  // projection used by GET /v1/panes/:id and the list endpoint.
  if (pane.status === "closed" || pane.expiresAt.getTime() < Date.now()) {
    throw errors.gone(
      "pane is closed — minting a new participant on a closed pane would not make it reachable",
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
  //     `findFirst({ where: { paneId, identityId } })` would non-
  //     deterministically resolve events to whichever row sorted first.
  //
  // The (paneId, identityId) unique constraint (#215) is the belt-and-
  // braces on this: two concurrent POSTs can both read everMintedHumans=N
  // and both try `h_${N}`, and the DB serialises the write so exactly one
  // wins on the constraint. The loser sees P2002 and the catch block below
  // re-reads the count + retries.
  //
  // Budget = max(cap, 5). The cap check at the top of every iteration
  // bounds the in-flight count of CONCURRENT mints to `cap` (anyone past
  // that point sees `activeHumans >= cap` and bails with 409). Each round
  // of the retry loop produces at least one winner — so the worst-case
  // loser succeeds within `cap` attempts. Pinning the budget to a fixed
  // small number (was 5) starved under reasonable concurrency: at the
  // default cap of 32, ~8 concurrent mints already started leaking P2002
  // as 500s (issue #231). The floor of 5 preserves prior behaviour for
  // tiny caps where the cap check itself prevents the race.
  const token = generateHumanParticipantToken();
  let participant;
  const MAX_MINT_ATTEMPTS = Math.max(5, config.MAX_PARTICIPANTS_PER_PANE);
  for (let attempt = 0; ; attempt++) {
    const [activeHumans, everMintedHumans] = await Promise.all([
      prisma.participant.count({
        where: { paneId: id, kind: "human", revokedAt: null },
      }),
      prisma.participant.count({
        where: { paneId: id, kind: "human" },
      }),
    ]);
    if (activeHumans >= config.MAX_PARTICIPANTS_PER_PANE) {
      throw errors.conflict(
        `pane already has ${activeHumans} active human participants (max ${config.MAX_PARTICIPANTS_PER_PANE}); revoke one before minting another`,
        false,
        "revoke an existing participant first with DELETE /v1/panes/:id/participants/:participant_id (CLI: `pane participant revoke`), then retry",
      );
    }

    try {
      participant = await prisma.participant.create({
        data: {
          paneId: id,
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
      //   - Prisma 6 (Rust engine): `meta.target = ["pane_id", "identity_id"]`
      //     on SQLite; constraint name on Postgres.
      //   - Prisma 7 (driver adapter): `meta.target` is empty / absent;
      //     the field list is carried in the message body
      //     ("Unique constraint failed on the fields: (`pane_id`, `identity_id`)").
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

// DELETE /v1/panes/:id/participants/:participant_id — revoke a single
// participant URL.
//
// Idempotent: an unknown / already-revoked / cross-pane participant id
// resolves to a 204, matching the attachment-token revoke contract (an agent
// retrying after a network blip must not see a different result). The
// bridge route already 404s on a revoked tokenHash (loadByToken in
// bridge/routes.ts), so this is the only HTTP change needed.
panes.delete("/:id/participants/:participant_id", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const participantId = c.req.param("participant_id");
  const me = c.get("agent");

  // Owner check on the pane first — cross-agent ids must 404 like every
  // other pane-scoped endpoint (existence-oracle parity with DELETE
  // /v1/panes/:id).
  const paneRaw = await prisma.pane.findUnique({ where: { id } });
  await assertPaneInScope(prisma, paneRaw, me);

  const participant = await prisma.participant.findUnique({
    where: { id: participantId },
  });

  // Idempotent miss path: an unknown participant id, or one belonging to
  // another pane, is silently a 204. This matches the agent's recovery
  // flow (revoke, possibly re-run after a partial failure) — surfacing a
  // 404 here would force the agent to handle two outcomes for what is
  // semantically the same "make sure this URL is dead" intent.
  if (!participant || participant.paneId !== id) {
    return c.body(null, 204);
  }

  // The pane's agent participant is load-bearing for the agent's own
  // WebSocket; revoking it would silently break the agent without closing
  // the pane. Reject explicitly with a hint pointing at the right verb.
  if (participant.kind === "agent") {
    throw errors.invalidRequest(
      "cannot revoke the agent participant",
      undefined,
      "the agent participant carries the pane's own websocket auth; to tear the pane down, call DELETE /v1/panes/:id (CLI: `pane delete <pane-id>`) instead",
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
});

export default panes;
