import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().default("file:./data/pane.db"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.string().url().optional(),
  API_KEY: z.string().optional(),
  PANE_SECRET_KEY: z.string().optional(),
  // Controls the POST /v1/register endpoint (see http/routes/register.ts):
  //   closed - DEFAULT. Endpoint returns 404. Agents get keys only via the
  //            API_KEY env / auto-mint. The safe default for self-hosters.
  //   secret - Endpoint requires `Authorization: Bearer <REGISTRATION_SECRET>`.
  //            A wrong/missing token is 401. Trusted-group invite mode.
  //   open   - Endpoint is public; anyone can register, bounded only by the
  //            per-IP rate limiter. For operators hosting publicly.
  REGISTRATION_MODE: z.enum(["closed", "secret", "open"]).default("closed"),
  // Shared secret for REGISTRATION_MODE=secret. Required (non-empty) in that
  // mode — validated below; ignored entirely when mode is closed or open.
  REGISTRATION_SECRET: z.string().optional(),
  // Per-IP rate limit for the POST /v1/register endpoint. Always enforced in
  // the secret and open modes. REGISTER_RATE_LIMIT=0 disables it (unlimited).
  REGISTER_RATE_LIMIT: z.coerce.number().int().min(0).default(5),
  REGISTER_RATE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  // General per-IP rate limit applied to every /v1/* and /s/* route.
  // RATE_LIMIT=0 disables the general limiter entirely (unlimited).
  RATE_LIMIT: z.coerce.number().int().min(0).default(120),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Comma-separated list of proxy IPs the relay sits directly behind. Only
  // when the socket peer is one of these is the `X-Forwarded-For` header
  // honored (taking the last untrusted hop). Empty = never trust XFF.
  //
  // The single value `*` means "trust X-Forwarded-For from any socket peer".
  // Use it ONLY when the relay is unreachable except through a proxy that
  // always sets/overwrites X-Forwarded-For — e.g. Azure Container Apps
  // ingress, whose ingress-to-container source IP is internal and not a
  // stable literal you could list. If the relay is directly reachable, `*`
  // would let a client spoof its rate-limit bucket — list explicit IPs then.
  TRUSTED_PROXY: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),
  // Max concurrent WebSocket connections per surface/token.
  // MAX_WS_CONNECTIONS_PER_SESSION=0 disables the cap.
  MAX_WS_CONNECTIONS_PER_SESSION: z.coerce.number().int().min(0).default(16),
  // Max number of open (non-closed) surfaces a single agent may hold.
  // MAX_SESSIONS_PER_AGENT=0 disables the cap.
  MAX_SESSIONS_PER_AGENT: z.coerce.number().int().min(0).default(50),
  // Max number of events a single surface may accumulate.
  // MAX_EVENTS_PER_SESSION=0 disables the cap.
  MAX_EVENTS_PER_SESSION: z.coerce.number().int().min(0).default(10_000),
  MAX_ARTIFACT_BYTES: z.coerce.number().int().positive().default(2_000_000),
  MAX_EVENT_DATA_BYTES: z.coerce.number().int().positive().default(65_536),
  // Cap on a single agent's freeform "taste notes" markdown attachment (see
  // /v1/taste). Stored verbatim on the Agent row, fetched and rewritten by
  // the agent itself, so this needs to fit comfortably in a prompt while
  // still bounding storage. 8 KiB is plenty for presentation-taste notes.
  MAX_TASTE_BYTES: z.coerce.number().int().positive().default(8_192),
  // Max number of templates (named + anonymous) a single agent may own.
  // MAX_ARTIFACTS_PER_AGENT=0 disables the cap.
  MAX_ARTIFACTS_PER_AGENT: z.coerce.number().int().min(0).default(100),
  // Max number of versions a single template may accumulate.
  // MAX_VERSIONS_PER_ARTIFACT=0 disables the cap.
  MAX_VERSIONS_PER_ARTIFACT: z.coerce.number().int().min(0).default(50),
  // Caps on the agent-supplied per-surface JSON Schema. The schema is compiled
  // by Ajv at surface-create / schema-patch time; an oversized or
  // pathologically-nested schema is a CPU sink, so both are bounded up front.
  MAX_SCHEMA_BYTES: z.coerce.number().int().positive().default(65_536),
  MAX_SCHEMA_DEPTH: z.coerce.number().int().positive().default(32),
  MAX_PARTICIPANTS_PER_SESSION: z.coerce.number().int().positive().default(32),
  DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  TTL_SWEEP_SECONDS: z.coerce.number().int().min(0).default(60),

  // ------------------------------------------------------------------
  // Blob attachments (v0.1.0)
  // ------------------------------------------------------------------
  // Selects the AttachmentStore implementation. "filesystem" is the zero-config
  // self-host default (single-VM only — does not work behind a multi-replica
  // autoscaler). "azure" requires the @azure/storage-blob runtime and is
  // gated behind this setting so a filesystem self-host never loads the SDK.
  // Other backends (s3, r2, gcs) are not implemented in v0.1.0 — see #152.
  BLOB_STORE: z.enum(["filesystem", "azure"]).default("filesystem"),

  // Per-attachment upload size cap. 5 MB covers any reasonable image or short PDF
  // and bounds the cost of being wrong about a single attachment. Raise per-relay
  // if needed; lower is the right v0.1.0 default.
  MAX_BLOB_BYTES: z.coerce.number().int().positive().default(5_000_000),

  // Per-surface aggregate cap on attached attachments. 100 MB ≈ 20 max-size attachments.
  MAX_BLOBS_PER_SESSION_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100_000_000),

  // Per-agent aggregate cap (across all of the agent's attachments in every scope).
  // 500 MB ≈ 100 max-size attachments. LRU eviction kicks in at this ceiling in a
  // later PR (#152 hardening section); v0.0-foundation just rejects at the cap.
  MAX_BLOBS_PER_AGENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(500_000_000),

  // Per-template aggregate cap (icons / fonts / static assets a UI needs to
  // render). Smaller than surface by design — template assets should be
  // lightweight.
  MAX_BLOBS_PER_ARTIFACT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50_000_000),

  // Filesystem backend root directory. Created on boot if missing; the relay
  // refuses to start if it exists with world-readable permissions (mode bits
  // & 0o007 !== 0). Files inside are written 0600.
  BLOB_STORE_FS_DIR: z.string().default("./data/attachments"),

  // ---- Azure Blob Storage backend (only consulted when BLOB_STORE=azure) ---
  //
  // The container the relay reads/writes. Created at startup if missing.
  BLOB_STORE_AZURE_CONTAINER: z.string().default("pane-attachments"),
  // Storage account URL — required for managed-identity auth (the production
  // path on Azure Container Apps). Example:
  //   https://stpaneeurprodblobs.attachment.core.windows.net
  // The hostname's first label is the account name; DefaultAzureCredential
  // negotiates the token.
  BLOB_STORE_AZURE_ACCOUNT_URL: z.string().optional(),
  // Connection-string fallback — DEV / Azurite ONLY. If set, takes precedence
  // over the managed-identity path. The relay logs a startup warning so
  // operators don't ship this to prod by mistake.
  BLOB_STORE_AZURE_CONNECTION_STRING: z.string().optional(),

  // Lifetime of a presigned PUT (filesystem signed nonce / Azure SAS). 10
  // minutes is enough for a human to upload from a phone over a slow
  // connection; long enough to be useful, short enough that a leaked
  // upload URL stops working before it can be replayed broadly.
  BLOB_PRESIGN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60),

  // Encrypt attachment bytes at rest before writing to the AttachmentStore. Off by
  // default — the hosted relay relies on Azure Blob's native at-rest
  // encryption. Self-host turning this on adds a per-attachment random DEK
  // wrapped under PANE_SECRET_KEY. See attachments/encrypt.ts for the threat
  // model (defends against storage-backend compromise without relay
  // compromise; does NOT defend against relay compromise).
  //
  // NOTE the bool parser: z.coerce.boolean() treats any non-empty string
  // as true (including "false"), so we use a strict comparator instead.
  BLOB_ENCRYPT_AT_REST: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === "true"),

  // Optional virus / content scan webhook. When set, every successful
  // upload is POSTed (HMAC-signed) to this URL; a non-clean verdict
  // refuses the attachment and deletes its bytes. Empty string / unset = no
  // scan. Validated at startup with the same SSRF guard as the template
  // and callback URLs — HTTPS only, no RFC1918, no cloud-metadata IPs.
  BLOB_SCAN_HOOK: z.string().optional(),

  // Per-request timeout for the scan hook. A scanner that takes longer
  // is treated as "infected" (fail-closed). Tight by design — a long
  // scanner blocks uploads.
  BLOB_SCAN_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // When the per-agent aggregate cap would be exceeded, evict oldest
  // agent-scope attachments (LRU by createdAt) to make room for the new one.
  // Surface-scope and template-scope attachments are NEVER evicted — they're
  // tied to a live surface / template and the cascade handles their
  // cleanup. When false, the relay rejects the upload with
  // quota_exceeded instead of evicting.
  BLOB_LRU_EVICTION: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => v === true || v === "true"),

  // Allowed MIME prefixes (matched as `mime.startsWith(prefix)`). Default
  // covers images and PDFs. Comma-separated for the env var; an empty string
  // disables the allowlist (every sniffed MIME is accepted — only sensible
  // for closed self-host).
  BLOB_MIME_ALLOWLIST: z
    .string()
    .default("image/,application/pdf")
    .transform((s) =>
      s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),

  // Default TTL for a /b/<token> capability URL minted against an
  // template-scope attachment. 30 days. Template-scope is the longest-lived; these
  // tokens are typically reused across many surface instances. Operators
  // tighten this if exposure tolerance is lower.
  BLOB_TOKEN_TTL_ARTIFACT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),

  // Default TTL for a /b/<token> capability URL minted against an agent-
  // scope attachment. 24 hours. Tightened from the original 7d design after the
  // security review (proposal #152) — long-lived agent tokens invited
  // "set and forget" leaks. Surface-scope tokens don't get a knob here:
  // they always inherit their surface's TTL exactly.
  BLOB_TOKEN_TTL_AGENT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60),

  // Lowest @paneui/cli version this relay accepts. When a /v1/* request
  // arrives with `x-pane-cli-version` set to a strictly-lower semver, the
  // relay responds with 426 cli_upgrade_required and the CLI prints an
  // actionable upgrade message (exit 75 — sysexits `EX_TEMPFAIL`).
  //
  // Default `0.0.0` opts the relay out — every header is accepted. Operators
  // bump this when they ship a relay that depends on a newer CLI behaviour
  // (a new endpoint, a changed payload shape). Requests with the header
  // ABSENT are NEVER rejected — that signals a library / non-CLI caller.
  //
  // The check uses strict semver comparison (no prerelease tags); values that
  // don't parse as semver are rejected at boot.
  MIN_CLI_VERSION: z
    .string()
    .regex(
      /^\d+\.\d+\.\d+$/,
      "MIN_CLI_VERSION must be a plain semver string like 0.1.0",
    )
    .default("0.0.0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Optional Redis connection string for multi-replica deployments. When set,
  // the relay backs its cross-process state (event pub/sub, the rate limiter
  // and the WebSocket presence registry) with Redis so multiple replicas stay
  // correct behind an autoscaler. When UNSET, the relay uses its in-process
  // implementations — correct for a single replica and required for the OSS
  // self-host / local path, which must not depend on a paid Redis service.
  // The `ioredis` package is an optionalDependency, loaded only when this is
  // set; a relay started with REDIS_URL but without it installed fails fast.
  REDIS_URL: z.string().optional(),
  // OpenTelemetry metrics. The relay is instrumented once with the
  // vendor-neutral OTel SDK; the exporter decides where telemetry goes.
  // METRICS_ENABLED=false makes the instrument helpers no-ops and omits the
  // MeterProvider.
  METRICS_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  // Selects the metrics/traces exporter. "azure" pushes metrics, traces and
  // exceptions to Azure Application Insights via the optional
  // @azure/monitor-opentelemetry-exporter package; "none" (the default)
  // collects no telemetry — operators opt in.
  // See telemetry/metrics.ts and telemetry/tracing.ts.
  METRICS_EXPORTER: z.enum(["azure", "none"]).default("none"),
  // Azure Application Insights connection string. Standard env var name used by
  // Azure Monitor tooling — kept verbatim so portal/CLI conventions line up.
  // REQUIRED when METRICS_EXPORTER=azure (validated below); ignored otherwise.
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),

  // ------------------------------------------------------------------
  // Human-side auth (Phase B): magic-link email provider
  // ------------------------------------------------------------------
  // The email provider used to deliver magic-link login emails. `none` (the
  // default) disables human-side login entirely — the relay still serves the
  // agent API and capability-URL surfaces, but POST /v1/auth/* returns 503.
  // Self-hosters who only need the agent surface leave this unset.
  // See docs/HUMAN-SIDE-PROPOSAL.md §4.3.
  EMAIL_PROVIDER: z
    .enum(["none", "dev", "azure", "smtp", "resend"])
    .default("none"),
  // The From: address used for magic-link emails. Required for every provider
  // except `none` and `dev`. Validated below.
  EMAIL_FROM: z.string().optional(),

  // ---- Azure Communication Services Email (EMAIL_PROVIDER=azure) ----
  //
  // Azure's transactional email service. Same Azure subscription as the
  // hosted relay; generous free tier (25K emails/month). Two auth modes,
  // pick exactly one:
  //
  //   1. Managed identity (preferred for prod on Azure Container Apps):
  //      set AZURE_COMMUNICATION_ENDPOINT_URL to the resource's endpoint
  //      (e.g. https://acs-eur-prod-pane.europe.communication.azure.com)
  //      and grant the relay's MI the "Communication and Email Service
  //      Owner" role on the Communication Service resource. No secret
  //      stored anywhere — DefaultAzureCredential picks up the MI token
  //      at request time.
  //
  //   2. Connection string (the simple path, useful for local testing or
  //      self-hosters without an MI): paste the primary connection string
  //      from the portal. The relay logs a startup warning so operators
  //      don't ship this to prod by mistake.
  //
  // If both are set the endpoint URL wins (MI is the better auth path).
  AZURE_COMMUNICATION_ENDPOINT_URL: z.string().url().optional(),
  AZURE_COMMUNICATION_CONNECTION_STRING: z.string().optional(),

  // ---- SMTP (EMAIL_PROVIDER=smtp) ----
  //
  // Generic SMTP for self-hosters using Gmail / Mailgun / Postmark / etc.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Whether to use TLS on connect (port 465). Otherwise STARTTLS is used
  // when the server advertises it (port 587 / 25).
  SMTP_SECURE: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === "true"),

  // ---- Resend (EMAIL_PROVIDER=resend) ----
  //
  // Modern transactional email service with a generous free tier (3K/month).
  // Fetch-based HTTP API; no SDK dependency.
  RESEND_API_KEY: z.string().optional(),

  // ---- Magic-link token TTL ----
  //
  // How long a magic-link token is valid after request. 15 min is enough for
  // a human to switch apps and click, short enough that a leaked link
  // expires before exploitation. See §6.1 (claim code uses the same default).
  MAGIC_LINK_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),

  // ---- Login (cookie) TTL ----
  //
  // How long a successful login cookie remains valid. 30 days is the
  // industry default for "remember me" style flows. The cookie is HTTP-only,
  // SameSite=Lax, Secure in production.
  LOGIN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends RawConfig {
  publicUrl: string;
  isProduction: boolean;
}

// Raised by loadConfig when an env var fails validation. Carries a
// human-readable, multi-line summary instead of a raw ZodError stack trace, so
// a self-hoster sees "PORT must be a number between 1 and 65535" rather than a
// dump of Zod internals.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatConfigError(err: z.ZodError): string {
  const lines = err.issues.map((issue) => {
    const field = issue.path.join(".") || "(root)";
    return `  - ${field}: ${issue.message}`;
  });
  return `invalid relay configuration:\n${lines.join("\n")}`;
}

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(formatConfigError(result.error));
  }
  const parsed = result.data;
  // Fail fast: the azure exporter cannot push anywhere without a connection
  // string. Catch the misconfiguration at startup with a clear message rather
  // than letting the exporter construction fail opaquely later. Raised as a
  // ConfigError so loadConfigOrExit prints it cleanly instead of stack-tracing.
  if (
    parsed.METRICS_ENABLED &&
    parsed.METRICS_EXPORTER === "azure" &&
    !parsed.APPLICATIONINSIGHTS_CONNECTION_STRING
  ) {
    throw new ConfigError(
      "invalid relay configuration:\n" +
        "  - APPLICATIONINSIGHTS_CONNECTION_STRING: required when METRICS_EXPORTER=azure " +
        "(the Application Insights connection string)",
    );
  }
  // Fail fast: REGISTRATION_MODE=secret gates POST /v1/register behind a
  // shared bearer secret, so the secret MUST be present and non-empty —
  // otherwise the endpoint could never be satisfied. Ignored for the closed
  // and open modes (the secret is unused there).
  if (
    parsed.REGISTRATION_MODE === "secret" &&
    (parsed.REGISTRATION_SECRET ?? "").length === 0
  ) {
    throw new ConfigError(
      "invalid relay configuration:\n" +
        "  - REGISTRATION_SECRET: required and non-empty when " +
        "REGISTRATION_MODE=secret (the shared bearer secret callers must present)",
    );
  }
  // Fail fast: every email provider except `none` and `dev` needs an
  // EMAIL_FROM address. Each provider also has its own provider-specific
  // requirement (connection string, API key, SMTP host).
  if (parsed.EMAIL_PROVIDER !== "none" && parsed.EMAIL_PROVIDER !== "dev") {
    if (!parsed.EMAIL_FROM || parsed.EMAIL_FROM.trim().length === 0) {
      throw new ConfigError(
        "invalid relay configuration:\n" +
          `  - EMAIL_FROM: required when EMAIL_PROVIDER=${parsed.EMAIL_PROVIDER} ` +
          "(the From: address on magic-link emails, e.g. noreply@example.com)",
      );
    }
  }
  if (
    parsed.EMAIL_PROVIDER === "azure" &&
    !parsed.AZURE_COMMUNICATION_ENDPOINT_URL &&
    !parsed.AZURE_COMMUNICATION_CONNECTION_STRING
  ) {
    throw new ConfigError(
      "invalid relay configuration:\n" +
        "  - EMAIL_PROVIDER=azure needs one of:\n" +
        "      AZURE_COMMUNICATION_ENDPOINT_URL  (managed-identity path,\n" +
        "        preferred on Azure; grant the relay's MI 'Communication\n" +
        "        and Email Service Owner' on the ACS resource); or\n" +
        "      AZURE_COMMUNICATION_CONNECTION_STRING  (connection-string\n" +
        "        path, simpler for local testing / non-Azure self-hosters)",
    );
  }
  if (parsed.EMAIL_PROVIDER === "smtp" && !parsed.SMTP_HOST) {
    throw new ConfigError(
      "invalid relay configuration:\n" +
        "  - SMTP_HOST: required when EMAIL_PROVIDER=smtp",
    );
  }
  if (parsed.EMAIL_PROVIDER === "resend" && !parsed.RESEND_API_KEY) {
    throw new ConfigError(
      "invalid relay configuration:\n" +
        "  - RESEND_API_KEY: required when EMAIL_PROVIDER=resend",
    );
  }
  const publicUrl = (
    parsed.PUBLIC_URL ?? `http://localhost:${parsed.PORT}`
  ).replace(/\/$/, "");
  return Object.freeze({
    ...parsed,
    publicUrl,
    isProduction: parsed.NODE_ENV === "production",
  }) as Config;
}

/**
 * Production-only sanity checks for config that is fine to default in local dev
 * but silently breaks a real deployment.
 *
 * PUBLIC_URL: human-facing surface URLs are built from it. On Azure Container
 * Apps the ingress FQDN isn't known until the app exists, so PUBLIC_URL is
 * wired in a second deploy step — until then it falls back to localhost and
 * every URL handed to a human is unreachable. Fail loudly rather than hand out
 * dead links. See docs/DEPLOY.md.
 *
 * Call once at startup, after loadConfig().
 */
export function validateProductionConfig(c: Config): void {
  if (!c.isProduction) return;

  const pub = c.PUBLIC_URL?.trim();
  if (!pub) {
    throw new Error(
      "PUBLIC_URL must be set in production — surface URLs are built from it. " +
        "On Azure Container Apps, set it to the ingress FQDN in a second deploy " +
        "step (https://<fqdn>). See docs/DEPLOY.md.",
    );
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(pub)) {
    throw new Error(
      `PUBLIC_URL still points at localhost (${pub}) in production — human-facing ` +
        "surface URLs would be unreachable. Set it to the public ingress URL. " +
        "See docs/DEPLOY.md.",
    );
  }
  if (!/^https:\/\//i.test(pub)) {
    // console rather than ./log to avoid a config <-> log import cycle.
    console.warn(
      `[pane] warning: PUBLIC_URL is not https in production (${pub})`,
    );
  }
}

export function redactConfig(c: Config): Record<string, unknown> {
  const r: Record<string, unknown> = { ...c };
  if (r.API_KEY) r.API_KEY = "<set>";
  if (r.PANE_SECRET_KEY) r.PANE_SECRET_KEY = "<set>";
  if (r.REGISTRATION_SECRET) r.REGISTRATION_SECRET = "<set>";
  if (r.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    // Connection string embeds an InstrumentationKey — never log it.
    r.APPLICATIONINSIGHTS_CONNECTION_STRING = "<set>";
  }
  if (r.AZURE_COMMUNICATION_CONNECTION_STRING) {
    r.AZURE_COMMUNICATION_CONNECTION_STRING = "<set>";
  }
  if (r.SMTP_PASS) r.SMTP_PASS = "<set>";
  if (r.RESEND_API_KEY) r.RESEND_API_KEY = "<set>";
  if (typeof r.DATABASE_URL === "string") {
    // Mask userinfo (scheme://user:pass@host) ...
    let url = r.DATABASE_URL.replace(/:\/\/([^@/]+)@/, "://<redacted>@");
    // ... and any password-bearing query param (e.g. ?password=secret,
    // ?pwd=secret), which some drivers accept instead of inline userinfo.
    url = url.replace(/([?&](?:password|pwd|pass)=)[^&]*/gi, "$1<redacted>");
    r.DATABASE_URL = url;
  }
  return r;
}

// Wraps loadConfig with a friendly exit path: a bad env var prints a clear,
// multi-line message and exits non-zero instead of stack-tracing a raw
// ZodError. Callers invoke this explicitly at startup — there is no module
// import-time singleton (the relay threads an explicit Config through buildApp).
export function loadConfigOrExit(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  try {
    return loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
