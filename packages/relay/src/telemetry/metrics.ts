// OpenTelemetry metrics for the pane relay.
//
// Design: the relay is instrumented ONCE with the vendor-neutral OpenTelemetry
// metrics SDK. An EXPORTER — selected by config (METRICS_EXPORTER) — decides
// where the telemetry goes:
//
//   - "prometheus": a PrometheusExporter whose serialized text is served by the
//     existing Hono app at GET /metrics (see http/app.ts). Self-host friendly:
//     one port, scrape-on-demand.
//   - "none": metrics collection is disabled entirely.
//
// FUTURE (issue #33, the hosted Azure deploy): an "azure" exporter would push
// to Application Insights via @opentelemetry/exporter-... + the Azure Monitor
// OTel exporter. That package pulls the Azure SDK in, so it is deliberately
// NOT a dependency of the OSS core. Adding it later is a localised change: add
// "azure" to the METRICS_EXPORTER enum in config.ts and a branch in initTelemetry()
// that constructs a PeriodicExportingMetricReader around the Azure exporter.
//
// Every call site uses the exported helper functions (recordSessionCreated(),
// recordEventWritten(), …) — they never touch the OTel API directly. When
// metrics are disabled the helpers are cheap no-ops and nothing throws.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider as ApiMeterProvider,
} from "@opentelemetry/api";
import { MeterProvider, type MetricReader } from "@opentelemetry/sdk-metrics";
import {
  PrometheusExporter,
  PrometheusSerializer,
} from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { Config } from "../config.js";
import prisma from "../db.js";
import { log } from "../log.js";
import { totalConnections } from "../ws/presence.js";

// --- module state -----------------------------------------------------------

let enabled = false;
let provider: MeterProvider | null = null;
let prometheusExporter: PrometheusExporter | null = null;

// Custom instruments. Undefined until initTelemetry() runs with metrics on.
let sessionsCreated: Counter | undefined;
let eventsWritten: Counter | undefined;
let registrations: Counter | undefined;
let errors: Counter | undefined;
let httpDuration: Histogram | undefined;

/** Author kinds an event can be attributed to — kept as a low-cardinality label. */
export type EventKind = "agent" | "human" | "system";

function readRelayVersion(): string {
  // rootDir is `src`, so package.json cannot be imported as a module — read it
  // at runtime from the package root and fall back gracefully.
  try {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return raw.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Initialise the metrics subsystem. Idempotent: safe to call once per process;
 * subsequent calls are no-ops. Must be called before buildApp() so the
 * instruments exist when routes/middleware register.
 */
export function initTelemetry(config: Config): void {
  if (provider !== null) return; // already initialised — keep the singleton

  if (!config.METRICS_ENABLED || config.METRICS_EXPORTER === "none") {
    log.info("telemetry disabled", {
      metricsEnabled: config.METRICS_ENABLED,
      exporter: config.METRICS_EXPORTER,
    });
    return;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "pane-relay",
    [ATTR_SERVICE_VERSION]: readRelayVersion(),
  });

  const readers: MetricReader[] = [];
  if (config.METRICS_EXPORTER === "prometheus") {
    // preventServerStart: true — we do NOT want the exporter's own HTTP server
    // on a separate port. The current metrics are serialized on demand and
    // served by the existing Hono app at GET /metrics instead.
    prometheusExporter = new PrometheusExporter({ preventServerStart: true });
    readers.push(prometheusExporter);
  }

  provider = new MeterProvider({ resource, readers });
  // Register as the global MeterProvider so the OTel API surface is consistent;
  // we still hold our own reference for shutdown/serialization.
  metrics.setGlobalMeterProvider(provider as unknown as ApiMeterProvider);

  const meter: Meter = provider.getMeter("pane-relay");

  sessionsCreated = meter.createCounter("pane_sessions_created_total", {
    description: "Total UI sessions created via POST /v1/sessions.",
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

  // pane_ws_connections_active — ObservableGauge backed by the in-memory
  // presence registry. Read on each collection; never throws.
  meter
    .createObservableGauge("pane_ws_connections_active", {
      description: "WebSocket connections currently open, by author kind.",
    })
    .addCallback((result) => {
      try {
        result.observe(totalConnections("agent"), { kind: "agent" });
        result.observe(totalConnections("human"), { kind: "human" });
      } catch (err) {
        log.warn("ws connections gauge callback failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

  // pane_sessions_open — ObservableGauge that counts currently-open sessions on
  // each collection. Prometheus scrapes ~every 15s, so one count query per
  // scrape is acceptable. The callback is resilient: a DB error is logged and
  // the observation is simply skipped, never thrown out of the callback.
  meter
    .createObservableGauge("pane_sessions_open", {
      description: "Sessions currently open (status=open, not expired).",
    })
    .addCallback(async (result) => {
      try {
        const count = await prisma.session.count({
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
    metricsRoute: config.METRICS_EXPORTER === "prometheus" ? "/metrics" : null,
  });
}

// --- instrument helpers ------------------------------------------------------
// All helpers are cheap no-ops when metrics are disabled.

/** Increment after a session is successfully created. */
export function recordSessionCreated(): void {
  sessionsCreated?.add(1);
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

// PrometheusSerializer is what the exporter's own HTTP handler uses; re-using
// it lets us serve the text from the existing Hono app instead of a 2nd port.
const prometheusSerializer = new PrometheusSerializer();

/**
 * Serialize the current metrics in the Prometheus text exposition format.
 * Returns null if metrics are disabled or the exporter is not Prometheus.
 */
export async function collectPrometheusMetrics(): Promise<string | null> {
  if (!prometheusExporter) return null;
  try {
    const { resourceMetrics, errors: collectErrors } =
      await prometheusExporter.collect();
    if (collectErrors.length > 0) {
      log.warn("metrics collection reported errors", {
        count: collectErrors.length,
      });
    }
    return prometheusSerializer.serialize(resourceMetrics);
  } catch (err) {
    log.warn("metrics collection failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
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
