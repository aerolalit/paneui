import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import type { AttachmentStore, RevokeCache } from "../attachments/index.js";
import type { SlidingWindowLimiter } from "./rate-limit.js";
import type { EmailProvider } from "../auth/email-provider.js";

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
    // Stricter limiter for POST /v1/auth/request-link, keyed on (IP, email).
    // Bounds magic-link email-bombing of a single address from rotating IPs.
    magicLinkLimiter: SlidingWindowLimiter;
    // General per-IP + per-token limiter for every /v1/* and /s/* route. The
    // same instance is also handed to the WebSocket-upgrade path via
    // attachWs(), so HTTP and WS-upgrade attempts share one IP bucket.
    generalLimiter: SlidingWindowLimiter;
    // Stricter per-IP limiter for ANONYMOUS / public record mutations on
    // /v1/panes/:id/records/:collection. Only anonymous (no token, no login
    // cookie) writes consume it; authenticated writes are exempt. Bounds the
    // public-pane anonymous-write spam surface — the HTTP-side peer of the WS
    // per-connection anonymous-emit cap (#445).
    anonRecordWriteLimiter: SlidingWindowLimiter;
    // Per-IP limiter for the OAuth endpoints + the unauthenticated /mcp
    // discovery path. These are mounted ahead of the general /v1 limiter (so
    // Claude's discovery probes aren't throttled by the agent-API bucket),
    // which left them unbounded — this restores a per-IP bound dedicated to
    // that surface. Only present when MCP_HTTP_ENABLED; the mcpOAuthRateLimit
    // middleware no-ops when it's absent.
    mcpOAuthLimiter?: SlidingWindowLimiter;
    // Configured AttachmentStore backend (filesystem or azure, per config.BLOB_STORE).
    // Optional in tests that don't exercise attachment routes — the /v1/attachments route
    // throws if it's missing so callers can't accidentally rely on an
    // unconfigured store.
    blobStore?: AttachmentStore;
    // In-memory cache of recently-revoked attachment token hashes — short-circuits
    // the DB row read on the /b/<token> hot path. The DB row remains the
    // source of truth; a miss falls back to checking revokedAt there. Always
    // set when blobStore is set.
    blobRevokeCache?: RevokeCache;
    // Email provider for the magic-link login flow (Phase B). Always set;
    // `provider.available = false` when EMAIL_PROVIDER=none, in which case
    // the /v1/auth/* routes return 503 auth_provider_unavailable.
    emailProvider: EmailProvider;
  };
};
