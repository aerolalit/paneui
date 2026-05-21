import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import type { BlobStore } from "../blobs/index.js";
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
    // Configured BlobStore backend (filesystem or azure, per config.BLOB_STORE).
    // Optional in tests that don't exercise blob routes — the /v1/blobs route
    // throws if it's missing so callers can't accidentally rely on an
    // unconfigured store.
    blobStore?: BlobStore;
  };
};
