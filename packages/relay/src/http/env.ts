import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import type { SlidingWindowLimiter } from "./rate-limit.js";

// Shared Hono environment. `prisma`, `config`, `registerLimiter` and
// `generalLimiter` are injected into the request context by buildApp()'s first
// middleware, so every route and middleware reads them via `c.get(...)`
// instead of importing module-level singletons.
export type AppEnv = {
  Variables: {
    prisma: PrismaClient;
    config: Config;
    // Per-IP limiter for the open POST /v1/register endpoint.
    registerLimiter: SlidingWindowLimiter;
    // General per-IP + per-token limiter for every /v1/* and /s/* route. The
    // same instance is also handed to the WebSocket-upgrade path via
    // attachWs(), so HTTP and WS-upgrade attempts share one IP bucket.
    generalLimiter: SlidingWindowLimiter;
  };
};
