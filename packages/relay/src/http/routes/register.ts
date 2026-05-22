// POST /v1/register — agent self-registration.
//
// This is the call that *obtains* an API key. Whether (and how) it is reachable
// is governed by the REGISTRATION_MODE config (see config.ts):
//   closed - DEFAULT. Endpoint returns 404; agents get keys via the API_KEY
//            env / auto-mint instead. The safe default for self-hosters.
//   secret - Requires `Authorization: Bearer <REGISTRATION_SECRET>`; a
//            wrong/missing token is 401. Trusted-group invite mode.
//   open   - Public; anyone can register. Abuse is bounded by a per-IP
//            sliding-window rate limit (see rate-limit.ts).
// The per-IP rate limiter runs in both the secret and open modes.

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";
import type { AppEnv } from "../env.js";
import { errors } from "../errors.js";
import { enforceRegisterRateLimit } from "../rate-limit.js";
import { recordRegistration } from "../../telemetry/metrics.js";

const bodySchema = z.object({
  name: z.string().min(1).max(64).optional(),
});

// Constant-time secret comparison. Returns false on a length mismatch without
// an early exit that would leak the length through timing; equal-length inputs
// go through crypto.timingSafeEqual.
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still run a constant-time compare against a same-length buffer so the
    // mismatch path does not short-circuit measurably faster.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const register = new Hono<AppEnv>();

register.post("/", async (c) => {
  const config = c.get("config");

  // Registration-mode gate. Runs before the rate limiter and body parse.
  if (config.REGISTRATION_MODE === "closed") {
    // Endpoint is disabled — present it as absent rather than 403 so a closed
    // relay does not advertise that registration exists at all.
    throw errors.notFound();
  }
  if (config.REGISTRATION_MODE === "secret") {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    const token = match?.[1] ?? "";
    if (
      token === "" ||
      !secretsMatch(token, config.REGISTRATION_SECRET ?? "")
    ) {
      throw errors.unauthorized();
    }
  }
  // mode === "open" falls through with no auth check.

  // Per-IP rate limit — always enforced in the secret and open modes.
  await enforceRegisterRateLimit(c);
  const prisma = c.get("prisma");

  // Body is optional — a bare `pane agent register` sends none. Treat missing /
  // empty / non-JSON body as {} so the only failure path is a malformed name.
  const raw = await c.req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success)
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );

  const key = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      name: parsed.data.name ?? "registered",
      keyHash: hashKey(key),
      keyPrefix: keyPrefix(key),
    },
  });

  recordRegistration();

  return c.json(
    {
      agent_id: agent.id,
      api_key: key,
      key_prefix: agent.keyPrefix,
    },
    201,
  );
});

export default register;
