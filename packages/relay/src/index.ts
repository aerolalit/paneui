// IMPORTANT: telemetry/bootstrap MUST be the first import. It registers the
// HTTP auto-instrumentation, which monkey-patches Node's `http` module — that
// patch must be installed before `@hono/node-server` (below) loads `http`.
import "./telemetry/bootstrap.js";
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { serve } from "@hono/node-server";
import {
  loadConfigOrExit,
  redactConfig,
  validateProductionConfig,
  type Config,
} from "./config.js";
import { createPrismaClient } from "./db.js";
import { runBootstrap } from "./bootstrap.js";
import { log } from "./log.js";
import { buildApp } from "./http/app.js";
import { makeEmailProvider } from "./auth/factory.js";
import { createRateLimiter } from "./http/rate-limit.js";
import { makeBlobStore, makeRevokeCache } from "./attachments/index.js";
import { attachWs } from "./ws/handler.js";
import { initTelemetry, shutdownTelemetry } from "./telemetry/metrics.js";
import { initTracing, shutdownTracing } from "./telemetry/tracing.js";
import { initLogs, shutdownLogs } from "./telemetry/logs.js";
import { invalidateSchemaCache } from "./core/validation.js";
import { sweepRecordTombstones } from "./core/records.js";
import { sweepAuthTokens, authSweepIntervalSeconds } from "./auth-sweeper.js";
import { reconcileOrphanedParticipants } from "./core/reconcile.js";
import { initRedis, shutdownRedis } from "./redis.js";
import { ensureKeyLoaded } from "./crypto.js";

// One TTL sweep pass: collect the expired pane ids first, then deleteMany,
// then drop each pane's compiled-validator cache entry. Two queries (no
// per-pane round-trip), so still O(1) DB calls regardless of batch size.
// Takes the Prisma client as a parameter — no module-level singleton — so the
// integration test can run it against its own isolated database.
//
// Also cleans up anonymous template orphans. Inline-form panes transparently
// create a Template row with name=null/slug=null (see panes.ts:404). When
// the only pane(s) using that template expire and get swept, the template
// itself is left behind forever — every smoke test, every one-off pane
// session leaves a permanent agent-owned row. Hard-deleting an anonymous
// template whose last referencing pane just went away cascades through
// template_versions automatically (onDelete: Cascade on the FK).
//
// We only touch templates that BOTH (a) are referenced by panes being
// swept in this tick AND (b) end up with zero remaining pane references
// AND (c) have null name + slug (the anonymity marker). Named templates and
// templates still referenced by an active pane are left alone.
export async function sweepExpiredPanes(prisma: PrismaClient): Promise<number> {
  const now = new Date();
  const expired = await prisma.pane.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true, templateVersionId: true },
  });
  if (expired.length === 0) return 0;
  const ids = expired.map((s) => s.id);

  // The template ids the expiring panes point at (via their pinned version).
  // We need these before the pane delete so we can re-check orphan status
  // after the delete commits.
  const candidateVersionIds = Array.from(
    new Set(expired.map((s) => s.templateVersionId)),
  );
  const candidateVersions = await prisma.templateVersion.findMany({
    where: { id: { in: candidateVersionIds } },
    select: { templateId: true },
  });
  const candidateTemplateIds = Array.from(
    new Set(candidateVersions.map((v) => v.templateId)),
  );

  const r = await prisma.pane.deleteMany({ where: { id: { in: ids } } });
  for (const id of ids) invalidateSchemaCache(id);

  // After the pane delete, find anonymous templates whose every version
  // is now pane-less. `versions.none.panes.some` reads as "no version
  // has any pane" — exactly the orphan predicate.
  if (candidateTemplateIds.length > 0) {
    const orphans = await prisma.template.findMany({
      where: {
        id: { in: candidateTemplateIds },
        name: null,
        slug: null,
        versions: { none: { panes: { some: {} } } },
      },
      select: { id: true },
    });
    if (orphans.length > 0) {
      await prisma.template.deleteMany({
        where: { id: { in: orphans.map((t) => t.id) } },
      });
    }
  }

  return r.count;
}

function startTtlSweeper(config: Config, prisma: PrismaClient): void {
  const intervalSec = config.TTL_SWEEP_SECONDS;
  if (intervalSec <= 0) {
    log.info("ttl sweeper disabled (TTL_SWEEP_SECONDS=0)");
    return;
  }
  const jitter = () =>
    Math.floor(Math.random() * Math.min(2000, intervalSec * 100));
  const tick = (): void => {
    void sweepExpiredPanes(prisma)
      .then((count) => {
        if (count > 0) log.debug("ttl swept", { count });
      })
      .catch((e) =>
        log.warn("ttl sweep error", {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
      // Recursive setTimeout (not setInterval) so each tick gets fresh jitter,
      // rather than a single fixed phase offset baked in at startup.
      .finally(() => {
        setTimeout(tick, intervalSec * 1000 + jitter());
      });
  };
  setTimeout(tick, intervalSec * 1000 + jitter());
  log.info("ttl sweeper started", { intervalSeconds: intervalSec });
}

// #293 — records tombstone sweeper. Hard-deletes soft-deleted PaneRecord
// rows that have been observable as tombstones for at least
// RECORD_TOMBSTONE_TTL_SECONDS. Mirrors startTtlSweeper structurally: same
// recursive-setTimeout + jitter pattern so multiple replicas don't lock-step.
function startRecordTombstoneSweeper(
  config: Config,
  prisma: PrismaClient,
): void {
  const intervalSec = config.RECORD_SWEEPER_INTERVAL_SECONDS;
  if (intervalSec <= 0) {
    log.info(
      "record tombstone sweeper disabled (RECORD_SWEEPER_INTERVAL_SECONDS=0)",
    );
    return;
  }
  const ttlSec = config.RECORD_TOMBSTONE_TTL_SECONDS;
  const jitter = () =>
    Math.floor(Math.random() * Math.min(2000, intervalSec * 100));
  const tick = (): void => {
    void sweepRecordTombstones(prisma, ttlSec)
      .then((count) => {
        if (count > 0) log.debug("record tombstones swept", { count });
      })
      .catch((e) =>
        log.warn("record tombstone sweep error", {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
      .finally(() => {
        setTimeout(tick, intervalSec * 1000 + jitter());
      });
  };
  setTimeout(tick, intervalSec * 1000 + jitter());
  log.info("record tombstone sweeper started", {
    intervalSeconds: intervalSec,
    ttlSeconds: ttlSec,
  });
}

// #307 — auth-state sweeper. Hard-deletes expired logins/magic-links/claim-
// codes/attachment-tokens. Distinct from the content-soft-delete sweepers
// above: these rows are transient auth state, no soft phase. Structurally
// identical to startTtlSweeper (recursive setTimeout + jitter).
function startAuthSweeper(prisma: PrismaClient): void {
  const intervalSec = authSweepIntervalSeconds();
  if (intervalSec <= 0) {
    log.info("auth-sweeper disabled (HARD_DELETE_SWEEP_SECONDS=0)");
    return;
  }
  const jitter = () =>
    Math.floor(Math.random() * Math.min(2000, intervalSec * 100));
  const tick = (): void => {
    void sweepAuthTokens(prisma)
      .catch((e) =>
        log.warn("auth sweep error", {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
      .finally(() => {
        setTimeout(tick, intervalSec * 1000 + jitter());
      });
  };
  setTimeout(tick, intervalSec * 1000 + jitter());
  log.info("auth-sweeper started", { intervalSeconds: intervalSec });
}

async function main(): Promise<void> {
  // The single process-wide config + Prisma client. main() is the ONLY place a
  // relay singleton is constructed; everything downstream receives them via
  // dependency injection (function parameters or the Hono request context).
  const config = loadConfigOrExit();
  const prisma = createPrismaClient(config.DATABASE_URL);

  log.info("starting pane relay", { config: redactConfig(config) });

  // Fail fast on production misconfiguration before binding a port:
  // PUBLIC_URL must be a real public URL, PANE_SECRET_KEY must be set.
  validateProductionConfig(config);
  ensureKeyLoaded();

  await runBootstrap(prisma, config);

  // Initialise the optional Redis backing for cross-process state (event
  // pub/sub, rate limiter, WS presence). No-op when REDIS_URL is unset — the
  // relay runs single-replica on its in-process implementations. When set,
  // this fails fast if `ioredis` is missing or Redis is unreachable, so a
  // misconfigured multi-replica deployment refuses to start rather than boot
  // with no shared state.
  await initRedis();

  // Close out any orphaned `system.participant.joined` events from a previous
  // process that crashed/restarted before writing the matching `left`. At this
  // point no WebSocket is connected, so every unpaired `joined` is provably
  // stale. See core/reconcile.ts.
  await reconcileOrphanedParticipants(prisma);

  // Initialise telemetry before buildApp() so the metric instruments exist
  // when routes/middleware register. initTelemetry is async because the azure
  // exporter is dynamically imported; no-op when METRICS_ENABLED=false.
  await initTelemetry(config, prisma);
  // Wire the TracerProvider + span exporter. Only does anything in azure mode
  // (prometheus has no trace ingestion story). The HTTP/DB instrumentation
  // itself was already registered by ./telemetry/bootstrap.js, imported first
  // above.
  await initTracing(config);
  // Wire the LoggerProvider + log exporter so the relay logger bridges to
  // Application Insights "Traces". Azure mode only; no-op otherwise.
  await initLogs(config);

  // One general per-IP + per-token rate limiter, shared by the Hono app
  // (/v1/* + /s/* routes) and the WebSocket-upgrade path. Built once here — the
  // single DI root — and handed to both buildApp() and attachWs() so HTTP
  // requests and WS-upgrade attempts bucket against the same per-IP state.
  const generalLimiter = createRateLimiter(
    config.RATE_LIMIT,
    config.RATE_LIMIT_WINDOW_SECONDS * 1000,
  );

  // Construct the configured AttachmentStore. Filesystem self-host validates +
  // creates BLOB_STORE_FS_DIR and refuses to start if it's world-readable.
  // Azure dynamic-imports its SDK + verifies / creates the container.
  const blobStore = await makeBlobStore(config);
  log.info("attachment store ready", {
    backend: config.BLOB_STORE,
    encryptAtRest: config.BLOB_ENCRYPT_AT_REST,
  });

  // Scan-hook SSRF validation. Fail-fast at startup so a misconfigured URL
  // never reaches an outbound fetch — the relay refuses to start when the
  // URL points at RFC1918, cloud-metadata, or a localhost address.
  if (config.BLOB_SCAN_HOOK) {
    const { assertSafeBlobScanHookUrl } = await import("./http/ssrf.js");
    await assertSafeBlobScanHookUrl(config.BLOB_SCAN_HOOK);
    log.info("attachment scan hook ready", {
      timeoutMs: config.BLOB_SCAN_TIMEOUT_MS,
    });
  }

  // Process-local revocation cache for /b/<token> short-circuiting. The DB
  // row remains the source of truth; the cache is a performance hint and
  // misses fall back to the row's revoked_at column.
  const blobRevokeCache = makeRevokeCache();

  // Resolve the email provider from config. When EMAIL_PROVIDER=none (the
  // default), the resulting provider has `available=false` and the
  // /v1/auth/* routes return 503. The async path is because the azure /
  // smtp providers dynamically `import()` their optional npm packages so
  // a self-host that doesn't pick them never loads the SDK.
  const emailProvider = await makeEmailProvider(config);
  log.info("email provider ready", {
    provider: emailProvider.kind,
    available: emailProvider.available,
  });

  const app = buildApp(
    config,
    prisma,
    generalLimiter,
    blobStore,
    blobRevokeCache,
    emailProvider,
  );

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log.info("listening", { port: info.port, publicUrl: config.publicUrl });
  });
  attachWs(server, { config, prisma, generalLimiter });
  startTtlSweeper(config, prisma);
  startRecordTombstoneSweeper(config, prisma);
  startAuthSweeper(prisma);

  // Flush metrics on a graceful shutdown signal. Minimal — the relay otherwise
  // just exits — but a flush lets the last scrape window's data settle.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void Promise.allSettled([
        shutdownTelemetry(),
        shutdownTracing(),
        shutdownLogs(),
        shutdownRedis(),
      ]).finally(() => process.exit(0));
    });
  }
}

// Only boot the relay when this module is the process entry point. When it is
// imported instead (e.g. the sweeper integration test importing
// `sweepExpiredPanes`), `main()` must not run — otherwise it would bind the
// HTTP port and start the TTL sweeper as an import side effect.
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => {
    log.error("fatal", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
