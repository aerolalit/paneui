import type { Context, MiddlewareHandler } from "hono";
import type { Agent, Participant, PrismaClient } from "@prisma/client";
import { hashKey } from "../keys.js";
import { log } from "../log.js";
import type { Author } from "../types.js";
import type { PaneWithTemplateVersion } from "../core/events.js";
import type { AppEnv } from "./env.js";
import { errors } from "./errors.js";

export type AuthEnv = AppEnv & {
  Variables: AppEnv["Variables"] & {
    agent: Agent;
    author: Author;
    // The pane is always loaded with its pinned template version eagerly
    // included — writeEvent + the bridge need the version's event schema.
    pane: PaneWithTemplateVersion;
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

// Resolve a raw token to either an agent or a (participant, pane) pair.
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
  | {
      kind: "participant";
      participant: Participant;
      pane: PaneWithTemplateVersion;
    }
  | null
> {
  const hash = hashKey(token);

  if (kind === "both") {
    const participant = await prisma.participant.findUnique({
      where: { tokenHash: hash },
    });
    if (participant) {
      if (participant.revokedAt) return null;
      const pane = await prisma.pane.findUnique({
        where: { id: participant.paneId },
        include: { templateVersion: true },
      });
      if (!pane) return null;
      return { kind: "participant", participant, pane };
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
// Accepts either the agent's bearer (when it matches pane.agentId) OR a
// participant token (when it matches a Participant row for this pane).
//
// Agent resolution is tried FIRST: a hit there skips the participant lookup
// entirely (one fewer DB round trip per agent-authenticated call). Only on an
// agent miss do we fall back to the participant lookup.
export const dualAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const prisma = c.get("prisma");
  const token = parseBearer(c);
  const paneId = c.req.param("id");
  if (!paneId) throw errors.notFound();
  const hash = hashKey(token);

  // Agent path: must own the pane.
  const agent = await prisma.agent.findUnique({ where: { keyHash: hash } });
  if (agent && !agent.revokedAt) {
    const pane = await prisma.pane.findUnique({
      where: { id: paneId },
      include: { templateVersion: true },
    });
    if (!pane || pane.agentId !== agent.id) throw errors.notFound();
    prisma.agent
      .update({ where: { id: agent.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) =>
        log.warn("lastUsedAt update failed", {
          agentId: agent.id,
          error: String(err),
        }),
      );
    c.set("agent", agent);
    c.set("pane", pane);
    c.set("author", { kind: "agent", id: agent.id });
    return next();
  }

  // Participant fallback.
  const participant = await prisma.participant.findUnique({
    where: { tokenHash: hash },
  });
  if (!participant || participant.revokedAt) throw errors.notFound();
  if (participant.paneId !== paneId) throw errors.notFound();
  const pane = await prisma.pane.findUnique({
    where: { id: participant.paneId },
    include: { templateVersion: true },
  });
  if (!pane) throw errors.notFound();
  // Note: `participant.joinedAt` is intentionally NOT stamped here. The SPEC
  // defines it as stamped "on first connect", and a connect is a WebSocket
  // upgrade — not an HTTP poll of GET /v1/panes/:id/events. A human who
  // only ever polls (the no-WS fallback) is reachable but has not "joined";
  // counting polls would inflate the "human joined" analytics. The stamp
  // lives solely in the WS upgrade path (src/ws/handler.ts). See issue #15.
  c.set("pane", pane);
  c.set("participant", participant);
  c.set("author", {
    kind: participant.kind === "agent" ? "agent" : "human",
    id: participant.identityId,
  });
  await next();
};
