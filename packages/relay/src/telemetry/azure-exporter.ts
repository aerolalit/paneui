// Loader for the OPTIONAL Azure Monitor OpenTelemetry exporter.
//
// pane is open-core. The Azure SDK is heavy and Azure-specific, so
// @azure/monitor-opentelemetry-exporter is declared in `optionalDependencies`
// (not `dependencies`) in package.json — a self-hoster's `npm install` may or
// may not pull it. It is therefore loaded lazily, via dynamic import, ONLY
// when METRICS_EXPORTER=azure. If it is missing we pane a clear, actionable
// error instead of an opaque module-not-found crash.

/** The subset of the Azure exporter package this relay uses. */
export interface AzureMonitorExporterModule {
  AzureMonitorMetricExporter: new (options: {
    connectionString: string;
  }) => object;
  AzureMonitorTraceExporter: new (options: {
    connectionString: string;
  }) => object;
  AzureMonitorLogExporter: new (options: {
    connectionString: string;
  }) => object;
}

/**
 * Dynamically import the Azure Monitor exporter package. Throws a clear,
 * actionable error if the optional dependency is not installed.
 */
export async function loadAzureExporter(): Promise<AzureMonitorExporterModule> {
  try {
    // Dynamic import: this specifier is only resolved when azure mode is
    // selected, so the OSS core never requires the package to be present.
    const mod =
      (await import("@azure/monitor-opentelemetry-exporter")) as unknown as AzureMonitorExporterModule;
    return mod;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      "METRICS_EXPORTER=azure requires the optional " +
        "@azure/monitor-opentelemetry-exporter package — run " +
        "`npm install @azure/monitor-opentelemetry-exporter` on the Azure host. " +
        `(underlying error: ${cause})`,
      { cause: err },
    );
  }
}
