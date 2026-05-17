// Shared OpenTelemetry Resource for the pane relay.
//
// Both the metrics MeterProvider (telemetry/metrics.ts) and the traces
// NodeTracerProvider (telemetry/tracing.ts) attach the SAME Resource so that
// every signal Azure Application Insights ingests agrees on `service.name`
// and `service.version`. Factored out here to keep the two providers in sync.

import { readFileSync } from "node:fs";
import path from "node:path";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

/** Stable logical service name for the relay across metrics and traces. */
export const SERVICE_NAME = "pane-relay";

/**
 * Read the relay's package version at runtime. `rootDir` is `src`, so
 * package.json cannot be imported as a module — read it from the package root
 * and fall back gracefully.
 */
export function readRelayVersion(): string {
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

/** Build the OTel Resource shared by the metrics and traces providers. */
export function buildResource(): ReturnType<typeof resourceFromAttributes> {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: readRelayVersion(),
  });
}
