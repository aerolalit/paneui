import { Hono } from "hono";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";

const keys = new Hono<AuthEnv>();

keys.use("*", requireAgent);

keys.get("/", (c) => {
  const agent = c.get("agent");
  return c.json({
    agent_id: agent.id,
    name: agent.name,
    key_prefix: agent.keyPrefix,
    created_at: agent.createdAt.toISOString(),
    last_used_at: agent.lastUsedAt?.toISOString() ?? null,
    revoked_at: agent.revokedAt?.toISOString() ?? null,
  });
});

keys.delete("/:id", async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  const id = c.req.param("id");
  if (id !== me.id) throw errors.forbidden();
  await prisma.agent.update({ where: { id }, data: { revokedAt: new Date() } });
  return c.body(null, 204);
});

export default keys;
