// OpenTelemetry tracing for the pane relay.
//
// Tracing is split into TWO phases because of a well-known OTel ordering
// footgun: `@opentelemetry/instrumentation-http` patches Node's `http`/`https`
// modules, and that monkey-patch MUST happen BEFORE those modules (and
// anything that imports them, e.g. `@hono/node-server`) are first required.
//
//   Phase 1 — registerHttpInstrumentation():
//     Called from telemetry/bootstrap.ts, which is the VERY FIRST import in
//     index.ts. Registers the HTTP instrumentation so the patch is installed
//     up front. No TracerProvider is needed yet — instrumentations emit spans
//     to whatever provider is registered later (or to a no-op until then).
//
//   Phase 2 — initTracing(config):
//     Called after config is loaded. Only when METRICS_EXPORTER=azure does it
//     build a NodeTracerProvider (sharing the metrics Resource) with an
//     AzureMonitorTraceExporter on a BatchSpanProcessor. In prometheus/none
//     mode NO provider is created and NO exporter is wired: Prometheus has no
//     trace ingestion story, so spans would have nowhere to go. The HTTP
//     instrumentation stays registered but harmlessly emits to a no-op tracer.

import { trace } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { buildResource } from "./resource.js";
import { loadAzureExporter } from "./azure-exporter.js";

let instrumentationRegistered = false;
let tracerProvider: NodeTracerProvider | null = null;

/**
 * Phase 1: register HTTP + DB auto-instrumentation. MUST run before the
 * instrumented modules are first imported — see the module header:
 *
 *   - HttpInstrumentation patches Node's `http`/`https`, which must happen
 *     before `@hono/node-server` (and thus `http`) loads.
 *   - PrismaInstrumentation hooks Prisma's tracing helper; it must be active
 *     before `@prisma/client` is imported (src/db.ts). Prisma 6 has tracing
 *     GA — no `previewFeatures` / schema change is needed; registering the
 *     instrumentation is sufficient.
 *   - PgInstrumentation patches the `pg` driver; relevant only for the
 *     Postgres engine, harmless (a no-op patch target) for SQLite.
 *
 * Registering instrumentation without a TracerProvider is fine — spans route
 * to a no-op tracer until initTracing() wires one (azure mode only).
 * Idempotent.
 */
export function registerHttpInstrumentation(): void {
  if (instrumentationRegistered) return;
  instrumentationRegistered = true;
  registerInstrumentations({
    instrumentations: [
      // Minimal, vendor-neutral set: HTTP request spans are the core value
      // for Application Insights (request traces + dependency timing). We do
      // not pull the auto-instrumentations meta-package. The relay's own
      // /healthz and /metrics endpoints are ignored to keep span volume sane.
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? "";
          return url === "/healthz" || url === "/metrics";
        },
      }),
      // DB dependency spans. App Insights renders these as "dependencies"
      // (child spans of a request) with timing. Cheap when no exporter is
      // wired (prometheus/none) — spans go to the no-op tracer.
      new PrismaInstrumentation(),
      new PgInstrumentation(),
    ],
  });
}

/**
 * Phase 2: wire a TracerProvider + span exporter. Only does anything in azure
 * mode; in prometheus/none mode it is a no-op (no trace backend exists).
 * Idempotent. Returns once the provider is registered (or immediately).
 */
export async function initTracing(config: Config): Promise<void> {
  if (tracerProvider !== null) return; // already initialised

  if (!config.METRICS_ENABLED || config.METRICS_EXPORTER !== "azure") {
    // prometheus / none: nothing ingests spans — skip the provider entirely.
    return;
  }

  const azure = await loadAzureExporter();
  const traceExporter = azure.AzureMonitorTraceExporter
    ? new azure.AzureMonitorTraceExporter({
        connectionString:
          config.APPLICATIONINSIGHTS_CONNECTION_STRING as string,
      })
    : null;
  if (!traceExporter) {
    log.warn("azure trace exporter unavailable — tracing not wired");
    return;
  }

  const processors: SpanProcessor[] = [
    new BatchSpanProcessor(
      traceExporter as ConstructorParameters<typeof BatchSpanProcessor>[0],
    ),
  ];
  tracerProvider = new NodeTracerProvider({
    resource: buildResource(),
    spanProcessors: processors,
  });
  tracerProvider.register();

  log.info("tracing initialised", { exporter: "azure" });
}

/** Flush and shut the TracerProvider down. Safe to call when not initialised. */
export async function shutdownTracing(): Promise<void> {
  if (!tracerProvider) return;
  try {
    await tracerProvider.forceFlush();
    await tracerProvider.shutdown();
  } catch (err) {
    log.warn("tracing shutdown failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record an exception on the currently-active span (if any) and mark the span
 * as errored. Called from the Hono onError handler so Application Insights
 * surfaces handled errors as exceptions on the request trace. No-op when no
 * span is active (e.g. prometheus mode, where no HTTP span provider exists).
 */
export function recordExceptionOnActiveSpan(err: unknown): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    span.recordException(error);
    // SpanStatusCode.ERROR === 2 — avoids an extra import for one constant.
    span.setStatus({ code: 2, message: error.message });
  } catch {
    // Never let telemetry bookkeeping break request handling.
  }
}
