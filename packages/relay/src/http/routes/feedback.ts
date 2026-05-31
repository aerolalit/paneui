// /v1/feedback — agent-authenticated one-shot feedback channel. POST writes
// a row (bug / feature / note + free-text message); GET lists the calling
// agent's own submissions. Operator triage is out of band (read the DB).

import { Hono } from "hono";
import { z } from "zod";
import { submitFeedbackSchema } from "@paneui/core";
import { requireAgent, type AuthEnv } from "../auth.js";
import { agentScope } from "../agent-scope.js";
import { errors } from "../errors.js";

const feedback = new Hono<AuthEnv>();

feedback.use("*", requireAgent);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  before: z.string().min(1).optional(),
});

interface FeedbackRow {
  id: string;
  type: string;
  message: string;
  surfaceId: string | null;
  createdAt: Date;
}

function serialize(row: FeedbackRow) {
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    surface_id: row.surfaceId,
    created_at: row.createdAt.toISOString(),
  };
}

feedback.post("/", async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");

  const body = await c.req.json().catch(() => null);
  const parsed = submitFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }
  const { type, message, surface_id } = parsed.data;

  if (surface_id !== undefined) {
    const surface = await prisma.surface.findUnique({
      where: { id: surface_id },
      select: { agentId: true },
    });
    // #283 — any same-human agent may attach feedback to a surface
    // owned by a sibling agent.
    const scope = await agentScope(prisma, me);
    if (!surface || !scope.has(surface.agentId)) throw errors.notFound();
  }

  const row = await prisma.feedback.create({
    data: {
      agentId: me.id,
      type,
      message,
      surfaceId: surface_id ?? null,
    },
    select: { id: true, type: true, createdAt: true },
  });

  return c.json(
    {
      id: row.id,
      type: row.type,
      created_at: row.createdAt.toISOString(),
    },
    201,
  );
});

feedback.get("/", async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");

  const parsed = listQuerySchema.safeParse({
    limit: c.req.query("limit"),
    before: c.req.query("before"),
  });
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid query",
      parsed.error.flatten(),
      "limit must be a positive integer (max 100); before must be a non-empty cursor returned by a previous page",
    );
  }
  const limit = parsed.data.limit ?? DEFAULT_LIMIT;
  const before = parsed.data.before;

  let beforeDate: Date | undefined;
  if (before !== undefined) {
    const d = new Date(before);
    if (Number.isNaN(d.getTime())) {
      throw errors.invalidRequest(
        "invalid cursor",
        undefined,
        "the `before` cursor must be an ISO timestamp returned by a previous page's `next_before`",
      );
    }
    beforeDate = d;
  }

  const rows = await prisma.feedback.findMany({
    where: {
      agentId: me.id,
      ...(beforeDate !== undefined ? { createdAt: { lt: beforeDate } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return c.json({
    items: page.map(serialize),
    ...(hasMore && last ? { next_before: last.createdAt.toISOString() } : {}),
  });
});

export default feedback;
