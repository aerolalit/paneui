// /v1/taste — per-agent freeform "taste notes" markdown attachment.
//
// A pane agent generates HTML templates for humans, and humans give the
// agent feedback on how those templates should look ("denser", "no rounded
// corners", "use a dark header"). Taste notes are where that feedback
// accumulates between panes: the agent reads the attachment before generating
// an template and rewrites it when the human gives new presentation
// feedback. Keyed by the calling agent's API key. Humans don't yet exist as
// a first-class identity in pane (v1), so per-agent is the closest available
// scope — this may move to per-human later.
//
// Body shape is whole-attachment replace, not append: the agent reads the current
// notes, merges in the new feedback, and writes back the full new attachment.
// Capped by config.MAX_TASTE_BYTES (utf8 bytes).

import { Hono } from "hono";
import { z } from "zod";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";

const taste = new Hono<AuthEnv>();

taste.use("*", requireAgent);

const putSchema = z.object({
  taste: z.string(),
});

function serialize(row: { taste: string | null; tasteUpdatedAt: Date | null }) {
  return {
    taste: row.taste,
    updated_at: row.tasteUpdatedAt?.toISOString() ?? null,
    bytes: row.taste !== null ? Buffer.byteLength(row.taste, "utf8") : 0,
  };
}

// GET /v1/taste — return the current notes attachment, the last update timestamp,
// and the utf8 byte size. taste/updated_at are null when the agent has never
// written notes.
taste.get("/", async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  const row = await prisma.agent.findUnique({
    where: { id: me.id },
    select: { taste: true, tasteUpdatedAt: true },
  });
  if (!row) throw errors.notFound();
  return c.json(serialize(row));
});

// PUT /v1/taste — whole-attachment replace. Empty/whitespace-only is rejected:
// callers asking to clear must DELETE. The cap is enforced on utf8 byte
// length, not character count.
taste.put("/", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const me = c.get("agent");

  const body = await c.req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }
  const { taste: nextTaste } = parsed.data;

  if (nextTaste.trim().length === 0) {
    throw errors.invalidRequest(
      "taste must not be empty or whitespace-only",
      undefined,
      "to clear the agent's taste notes, send DELETE /v1/taste instead of PUT with an empty body",
    );
  }

  if (Buffer.byteLength(nextTaste, "utf8") > config.MAX_TASTE_BYTES) {
    throw errors.payloadTooLarge();
  }

  const row = await prisma.agent.update({
    where: { id: me.id },
    data: { taste: nextTaste, tasteUpdatedAt: new Date() },
    select: { taste: true, tasteUpdatedAt: true },
  });
  return c.json(serialize(row));
});

// DELETE /v1/taste — clear the notes attachment. Idempotent: clearing already-null
// notes still returns 204.
taste.delete("/", async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  await prisma.agent.update({
    where: { id: me.id },
    data: { taste: null, tasteUpdatedAt: null },
  });
  return c.body(null, 204);
});

export default taste;
