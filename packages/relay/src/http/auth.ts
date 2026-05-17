import type { Context, MiddlewareHandler } from "hono";
import type { Agent, Participant, PrismaClient, Session } from "@prisma/client";
import { hashKey } from "../keys.js";
import { log } from "../log.js";
import type { Author } from "../types.js";
import type { AppEnv } from "./env.js";
import { errors } from "./errors.js";

export type AuthEnv = AppEnv & {
  Variables: AppEnv["Variables"] & {
    agent: Agent;
    author: Author;
    session: Session;
    participant: Participant;
  };
};

function parseBearer(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw errors.unauthorized();
  return match[1]!.trim();
}

// Which token kinds the caller is willing to accept. Agent-only routes pass
// "agent" so resolveBearer can skip the always-miss participant lookup.
type ResolveKind = "agent" | "both";

// Resolve a raw token to either an agent or a (participant, session) pair.
// Used by both the HTTP middlewares and the WebSocket upgrade.
//
// `kind` lets an agent-only caller (requireAgent) skip the participant
// findUnique entirely — that lookup is a guaranteed miss for an agent token,
// so it's a wasted DB round trip on every agent-authenticated request. Callers
// that genuinely accept either token (dualAuth, the WS upgrade) pass "both".
export async function resolveBearer(
  prisma: PrismaClient,
  token: string,
  kind: ResolveKind = "both",
): Promise<
  | { kind: "agent"; agent: Agent }
  | { kind: "participant"; participant: Participant; session: Session }
  | null
> {
  const hash = hashKey(token);

  if (kind === "both") {
    const participant = await prisma.participant.findUnique({
      where: { tokenHash: hash },
    });
    if (participant) {
      if (participant.revokedAt) return null;
      const session = await prisma.session.findUnique({
        where: { id: participant.sessionId },
      });
      if (!session) return null;
      return { kind: "participant", participant, session };
    }
  }

  const agent = await prisma.agent.findUnique({ where: { keyHash: hash } });
  if (agent && !agent.revokedAt) return { kind: "agent", agent };
  return null;
}

export const requireAgent: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const prisma = c.get("prisma");
  const token = parseBearer(c);
  // Agent-only route — skip the participant lookup (a guaranteed miss here).
  const resolved = await resolveBearer(prisma, token, "agent");
  if (!resolved || resolved.kind !== "agent") throw errors.unauthorized();
  const agent = resolved.agent;
  prisma.agent
    .update({ where: { id: agent.id }, data: { lastUsedAt: new Date() } })
    .catch((err: unknown) =>
      log.warn("lastUsedAt update failed", {
        agentId: agent.id,
        error: String(err),
      }),
    );
  c.set("agent", agent);
  c.set("author", { kind: "agent", id: agent.id });
  await next();
};

// Dual auth for the events endpoints + WS upgrade.
// Accepts either the agent's bearer (when it matches session.agentId) OR a
// participant token (when it matches a Participant row for this session).
//
// Agent resolution is tried FIRST: a hit there skips the participant lookup
// entirely (one fewer DB round trip per agent-authenticated call). Only on an
// agent miss do we fall back to the participant lookup.
export const dualAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const prisma = c.get("prisma");
  const token = parseBearer(c);
  const sessionId = c.req.param("id");
  if (!sessionId) throw errors.notFound();
  const hash = hashKey(token);

  // Agent path: must own the session.
  const agent = await prisma.agent.findUnique({ where: { keyHash: hash } });
  if (agent && !agent.revokedAt) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.agentId !== agent.id) throw errors.notFound();
    prisma.agent
      .update({ where: { id: agent.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) =>
        log.warn("lastUsedAt update failed", {
          agentId: agent.id,
          error: String(err),
        }),
      );
    c.set("agent", agent);
    c.set("session", session);
    c.set("author", { kind: "agent", id: agent.id });
    return next();
  }

  // Participant fallback.
  const participant = await prisma.participant.findUnique({
    where: { tokenHash: hash },
  });
  if (!participant || participant.revokedAt) throw errors.notFound();
  if (participant.sessionId !== sessionId) throw errors.notFound();
  const session = await prisma.session.findUnique({
    where: { id: participant.sessionId },
  });
  if (!session) throw errors.notFound();
  if (!participant.joinedAt) {
    await prisma.participant.update({
      where: { id: participant.id },
      data: { joinedAt: new Date() },
    });
  }
  c.set("session", session);
  c.set("participant", participant);
  c.set("author", {
    kind: participant.kind === "agent" ? "agent" : "human",
    id: participant.identityId,
  });
  await next();
};
