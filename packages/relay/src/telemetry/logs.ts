// OpenTelemetry logs bridge for the pane relay.
//
// The relay's hand-rolled logger (src/log.ts) writes JSON lines to stdout.
// This module bridges those log calls onto the OTel Logs SDK so that, in
// azure mode, they also flow to Application Insights' "Traces" table.
//
// Design — mirrors telemetry/tracing.ts:
//
//   - A LoggerProvider is built ONLY in azure mode (initLogs), sharing the
//     same Resource as the metrics/traces providers. It uses a
//     BatchLogRecordProcessor feeding an AzureMonitorLogExporter (loaded via
//     the optional-dependency dynamic-import helper).
//   - In prometheus/none mode no provider is created — emitLogRecord() is a
//     cheap no-op and log lines go to stdout only, exactly as before.
//
// Import-cycle safety: src/log.ts is imported extremely widely (including by
// config.ts) and runs during startup BEFORE telemetry is initialised. log.ts
// therefore must NOT import a heavy telemetry module at module scope. It
// imports only this file, whose module-init is trivial; emitLogRecord() is a
// guarded no-op until initLogs() installs a LoggerProvider. Early startup
// logs (before initLogs) simply are not bridged — acceptable.

import {
  SeverityNumber,
  type Logger,
  type LogRecord,
} from "@opentelemetry/api-logs";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { Config } from "../config.js";
import { buildResource } from "./resource.js";
import { loadAzureExporter } from "./azure-exporter.js";

// --- module state -----------------------------------------------------------

let loggerProvider: LoggerProvider | null = null;
let logger: Logger | null = null;

/** Relay log level → OTel SeverityNumber. */
const SEVERITY: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/**
 * Wire a LoggerProvider + log-record exporter. Only does anything in azure
 * mode; in prometheus/none mode it is a no-op (no log backend exists, logs
 * stay on stdout). Idempotent. Async because the Azure exporter is loaded via
 * dynamic import (optional dependency).
 */
export async function initLogs(config: Config): Promise<void> {
  if (loggerProvider !== null) return; // already initialised

  if (!config.METRICS_ENABLED || config.METRICS_EXPORTER !== "azure") {
    // prometheus / none: nothing ingests logs — skip the provider entirely.
    return;
  }

  const azure = await loadAzureExporter();
  if (!azure.AzureMonitorLogExporter) return;
  const logExporter = new azure.AzureMonitorLogExporter({
    connectionString: config.APPLICATIONINSIGHTS_CONNECTION_STRING as string,
  });

  const processors: LogRecordProcessor[] = [
    new BatchLogRecordProcessor(
      logExporter as ConstructorParameters<typeof BatchLogRecordProcessor>[0],
    ),
  ];
  loggerProvider = new LoggerProvider({
    resource: buildResource(),
    processors,
  });
  logger = loggerProvider.getLogger("pane-relay");
}

/**
 * Emit an OTel log record for a relay log line. No-op until initLogs() has
 * installed a LoggerProvider (i.e. always a no-op outside azure mode). Called
 * from src/log.ts AFTER the stdout write — never throws.
 *
 * Trace/span correlation is automatic: the Logs SDK stamps the active context
 * (trace_id / span_id) onto the record, so App Insights links the log line to
 * its request. We do not pass an explicit context.
 */
export function emitLogRecord(
  level: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if (!logger) return;
  try {
    const record: LogRecord = {
      severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
      severityText: level.toUpperCase(),
      body: msg,
      attributes: meta as LogRecord["attributes"],
    };
    logger.emit(record);
  } catch {
    // Telemetry bookkeeping must never break a log call.
  }
}

/** Flush and shut the LoggerProvider down. Safe to call when not initialised. */
export async function shutdownLogs(): Promise<void> {
  if (!loggerProvider) return;
  try {
    await loggerProvider.forceFlush();
    await loggerProvider.shutdown();
  } catch {
    // Swallow — shutdown is best-effort.
  }
}
