import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("file:./data/pane.db"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.string().url().optional(),
  API_KEY: z.string().optional(),
  PANE_SECRET_KEY: z.string().optional(),
  // Per-IP rate limit for the open POST /v1/register endpoint.
  // REGISTER_RATE_LIMIT=0 disables the limiter entirely (unlimited).
  REGISTER_RATE_LIMIT: z.coerce.number().int().min(0).default(5),
  REGISTER_RATE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  MAX_ARTIFACT_BYTES: z.coerce.number().int().positive().default(2_000_000),
  MAX_EVENT_DATA_BYTES: z.coerce.number().int().positive().default(65_536),
  // Caps on the agent-supplied per-session JSON Schema. The schema is compiled
  // by Ajv at session-create / schema-patch time; an oversized or
  // pathologically-nested schema is a CPU sink, so both are bounded up front.
  MAX_SCHEMA_BYTES: z.coerce.number().int().positive().default(65_536),
  MAX_SCHEMA_DEPTH: z.coerce.number().int().positive().default(32),
  MAX_PARTICIPANTS_PER_SESSION: z.coerce.number().int().positive().default(32),
  DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  TTL_SWEEP_SECONDS: z.coerce.number().int().min(0).default(60),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // OpenTelemetry metrics. The relay is instrumented once with the
  // vendor-neutral OTel SDK; the exporter decides where telemetry goes.
  // METRICS_ENABLED=false makes the instrument helpers no-ops, omits the
  // MeterProvider, and unmounts GET /metrics.
  METRICS_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  // Selects the metrics/traces exporter. "prometheus" exposes GET /metrics in
  // the Prometheus text format on the existing Hono app; "azure" pushes
  // metrics, traces and exceptions to Azure Application Insights via the
  // optional @azure/monitor-opentelemetry-exporter package; "none" (the
  // default) collects no telemetry and mounts nothing — operators opt in.
  // See telemetry/metrics.ts and telemetry/tracing.ts.
  METRICS_EXPORTER: z.enum(["prometheus", "azure", "none"]).default("none"),
  // Azure Application Insights connection string. Standard env var name used by
  // Azure Monitor tooling — kept verbatim so portal/CLI conventions line up.
  // REQUIRED when METRICS_EXPORTER=azure (validated below); ignored otherwise.
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends RawConfig {
  publicUrl: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const parsed = schema.parse(env);
  // Fail fast: the azure exporter cannot push anywhere without a connection
  // string. Catch the misconfiguration at startup with a clear message rather
  // than letting the exporter construction fail opaquely later.
  if (
    parsed.METRICS_ENABLED &&
    parsed.METRICS_EXPORTER === "azure" &&
    !parsed.APPLICATIONINSIGHTS_CONNECTION_STRING
  ) {
    throw new Error(
      "METRICS_EXPORTER=azure requires APPLICATIONINSIGHTS_CONNECTION_STRING to be set " +
        "(the Application Insights connection string).",
    );
  }
  const publicUrl = (
    parsed.PUBLIC_URL ?? `http://localhost:${parsed.PORT}`
  ).replace(/\/$/, "");
  return Object.freeze({ ...parsed, publicUrl }) as Config;
}

export function redactConfig(c: Config): Record<string, unknown> {
  const r: Record<string, unknown> = { ...c };
  if (r.API_KEY) r.API_KEY = "<set>";
  if (r.PANE_SECRET_KEY) r.PANE_SECRET_KEY = "<set>";
  if (r.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    // Connection string embeds an InstrumentationKey — never log it.
    r.APPLICATIONINSIGHTS_CONNECTION_STRING = "<set>";
  }
  if (typeof r.DATABASE_URL === "string") {
    r.DATABASE_URL = r.DATABASE_URL.replace(/:\/\/([^@/]+)@/, "://<redacted>@");
  }
  return r;
}

const config = loadConfig();
export default config;
