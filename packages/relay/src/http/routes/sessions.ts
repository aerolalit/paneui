import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { createSessionSchema } from "@paneui/core";
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
  validateSchemaShape,
  validateInputData,
} from "../../core/validation.js";
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

  const { artifact, participants, ttl, metadata, callback, input_data } =
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

  if ("id" in artifact && artifact.id !== undefined) {
    // Reference form — instance an existing named artifact owned by this agent.
    // `artifact.id` accepts the artifact id or its slug.
    const head = await prisma.artifact.findFirst({
      where: {
        ownerId: agent.id,
        OR: [{ id: artifact.id }, { slug: artifact.id }],
      },
    });
    if (!head) throw errors.notFound();
    const wantVersion = artifact.version ?? head.latestVersion;
    const version = await prisma.artifactVersion.findUnique({
      where: {
        artifactId_version: { artifactId: head.id, version: wantVersion },
      },
    });
    if (!version) throw errors.notFound();
    artifactVersionId = version.id;
    artifactId = head.id;
    inputSchema = version.inputSchema;
  } else {
    // Inline form — a one-off UI. Validate the inline content, then
    // transparently create an anonymous artifact (name/slug null) + v1.
    const inline = artifact as {
      source: string;
      type: "html-inline" | "html-ref";
      event_schema?: unknown;
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
          inputSchema: Prisma.JsonNull,
        },
      });
      return { headId: head.id, versionId: version.id };
    });
    artifactVersionId = created.versionId;
    artifactId = created.headId;
  }

  // Phase C — input contract enforcement. If the pinned version declares an
  // `input_schema`, the session's `input_data` must satisfy it; validate now,
  // BEFORE the session row is created, so a bad request creates nothing. A
  // missing `input_data` is validated as `{}` so the schema's `required`
  // fields fail naturally. When the version has NO `input_schema` there is no
  // input contract — `input_data` (if supplied) passes through unvalidated.
  if (inputSchema != null && typeof inputSchema === "object") {
    validateInputData(inputSchema as object, input_data ?? {});
  }

  const ttlSeconds = Math.min(
    Math.max(1, ttl ?? config.DEFAULT_TTL_SECONDS),
    config.MAX_TTL_SECONDS,
  );
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
  if (!session || session.agentId !== me.id) throw errors.notFound();
  const isExpired = session.expiresAt.getTime() < Date.now();
  return c.json({
    session_id: session.id,
    status: isExpired ? "closed" : session.status,
    artifact_id: session.artifactVersion.artifactId,
    artifact_version_id: session.artifactVersionId,
    artifact_version: session.artifactVersion.version,
    metadata: session.metadata,
    input_data: session.inputData,
    created_at: session.createdAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
  });
});

sessions.delete("/:id", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.notFound();
  if (session.status === "closed") return c.body(null, 204);
  await prisma.session.update({
    where: { id },
    data: { status: "closed", expiresAt: new Date() },
  });
  await appendSystemEvent(prisma, id, "system.session.expired", {});
  return c.body(null, 204);
});

export default sessions;
