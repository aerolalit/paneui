// OpenTelemetry metrics for the pane relay.
//
// Design: the relay is instrumented ONCE with the vendor-neutral OpenTelemetry
// metrics SDK. An EXPORTER — selected by config (METRICS_EXPORTER) — decides
// where the telemetry goes:
//
//   - "azure": an AzureMonitorMetricExporter (Application Insights) on a
//     PeriodicExportingMetricReader. The Azure SDK is an OPTIONAL dependency
//     (see telemetry/azure-exporter.ts) loaded via dynamic import — the OSS
//     core does not require it.
//   - "none": metrics collection is disabled entirely.
//
// Tracing lives in a sibling module (telemetry/tracing.ts) and follows the
// same exporter switch. Both providers share telemetry/resource.ts so every
// signal agrees on service.name / service.version.
//
// Every call site uses the exported helper functions (recordSessionCreated(),
// recordEventWritten(), …) — they never touch the OTel API directly. When
// metrics are disabled the helpers are cheap no-ops and nothing throws.

import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider as ApiMeterProvider,
} from "@opentelemetry/api";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { totalConnections } from "../ws/presence.js";
import { buildResource } from "./resource.js";
import { loadAzureExporter } from "./azure-exporter.js";

// --- module state -----------------------------------------------------------

let enabled = false;
let provider: MeterProvider | null = null;

// Custom instruments. Undefined until initTelemetry() runs with metrics on.
let surfacesCreated: Counter | undefined;
let eventsWritten: Counter | undefined;
let registrations: Counter | undefined;
let errors: Counter | undefined;
let httpDuration: Histogram | undefined;

/** Author kinds an event can be attributed to — kept as a low-cardinality label. */
export type EventKind = "agent" | "human" | "system";

/**
 * Initialise the metrics subsystem. Idempotent: safe to call once per process;
 * subsequent calls are no-ops. Must be called before buildApp() so the
 * instruments exist when routes/middleware register.
 *
 * Async because the "azure" exporter is loaded via dynamic import (it is an
 * optional dependency). The "none" path resolves synchronously.
 *
 * `prisma` is injected (not a module singleton) so the pane_surfaces_open
 * ObservableGauge can count rows against the same client the app uses.
 */
export async function initTelemetry(
  config: Config,
  prisma: PrismaClient,
): Promise<void> {
  if (provider !== null) return; // already initialised — keep the singleton

  if (!config.METRICS_ENABLED || config.METRICS_EXPORTER === "none") {
    log.info("telemetry disabled", {
      metricsEnabled: config.METRICS_ENABLED,
      exporter: config.METRICS_EXPORTER,
    });
    return;
  }

  const resource = buildResource();

  const readers: MetricReader[] = [];
  if (config.METRICS_EXPORTER === "azure") {
    // Push model: the Azure Monitor metric exporter periodically flushes to
    // Application Insights. The Azure package is an OPTIONAL dependency loaded
    // via dynamic import — a missing package yields a clear, actionable error.
    const azure = await loadAzureExporter();
    const azureExporter = new azure.AzureMonitorMetricExporter({
      connectionString: config.APPLICATIONINSIGHTS_CONNECTION_STRING as string,
    }) as unknown as PushMetricExporter;
    readers.push(
      new PeriodicExportingMetricReader({ exporter: azureExporter }),
    );
  }

  provider = new MeterProvider({ resource, readers });
  // Register as the global MeterProvider so the OTel API pane is consistent;
  // we still hold our own reference for shutdown/serialization.
  metrics.setGlobalMeterProvider(provider as unknown as ApiMeterProvider);

  const meter: Meter = provider.getMeter("pane-relay");

  surfacesCreated = meter.createCounter("pane_surfaces_created_total", {
    description: "Total UI panes created via POST /v1/panes.",
  });
  eventsWritten = meter.createCounter("pane_events_written_total", {
    description: "Total events persisted, labelled by author kind.",
  });
  registrations = meter.createCounter("pane_registrations_total", {
    description: "Total successful agent self-registrations.",
  });
  errors = meter.createCounter("pane_errors_total", {
    description: "Total ApiErrors returned, labelled by error code.",
  });
  httpDuration = meter.createHistogram("pane_http_request_duration_seconds", {
    description: "HTTP request duration in seconds.",
    unit: "s",
  });

  // pane_ws_connections_active — ObservableGauge backed by the presence
  // registry. Read on each collection; never throws. The callback is async
  // because the presence registry is async (Redis-backed in multi-replica
  // mode); the OTel metrics SDK awaits an async ObservableGauge callback.
  meter
    .createObservableGauge("pane_ws_connections_active", {
      description: "WebSocket connections currently open, by author kind.",
    })
    .addCallback(async (result) => {
      try {
        result.observe(await totalConnections("agent"), { kind: "agent" });
        result.observe(await totalConnections("human"), { kind: "human" });
      } catch (err) {
        log.warn("ws connections gauge callback failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

  // pane_surfaces_open — ObservableGauge that counts currently-open panes on
  // each collection. The exporter reads it periodically, so one count query per
  // collection is acceptable. The callback is resilient: a DB error is logged
  // and the observation is simply skipped, never thrown out of the callback.
  meter
    .createObservableGauge("pane_surfaces_open", {
      description: "Sessions currently open (status=open, not expired).",
    })
    .addCallback(async (result) => {
      try {
        const count = await prisma.pane.count({
          where: { status: "open", expiresAt: { gt: new Date() } },
        });
        result.observe(count);
      } catch (err) {
        log.warn("sessions_open gauge callback failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

  enabled = true;
  log.info("telemetry initialised", {
    exporter: config.METRICS_EXPORTER,
  });
}

// --- instrument helpers ------------------------------------------------------
// All helpers are cheap no-ops when metrics are disabled.

/** Increment after a pane is successfully created. */
export function recordSessionCreated(): void {
  surfacesCreated?.add(1);
}

/** Increment per persisted event, labelled by the author kind. */
export function recordEventWritten(kind: EventKind): void {
  eventsWritten?.add(1, { kind });
}

/** Increment after a successful agent self-registration. */
export function recordRegistration(): void {
  registrations?.add(1);
}

/** Increment when an ApiError is returned, labelled by its (low-cardinality) code. */
export function recordError(code: string): void {
  errors?.add(1, { code });
}

/** Record an HTTP request's duration. `route` MUST be a low-cardinality pattern. */
export function recordHttpDuration(
  seconds: number,
  attrs: { method: string; route: string; status: number },
): void {
  httpDuration?.record(seconds, {
    method: attrs.method,
    route: attrs.route,
    status_class: `${Math.floor(attrs.status / 100)}xx`,
  });
}

/** Whether metrics collection is active (METRICS_ENABLED + a real exporter). */
export function metricsEnabled(): boolean {
  return enabled;
}

/** Flush and shut the MeterProvider down. Safe to call when disabled. */
export async function shutdownTelemetry(): Promise<void> {
  if (!provider) return;
  try {
    await provider.forceFlush();
    await provider.shutdown();
  } catch (err) {
    log.warn("telemetry shutdown failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
