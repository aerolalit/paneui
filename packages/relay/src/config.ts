import { z } from "zod";
import { RASTER_ICON_MIME_ALLOWLIST } from "@paneui/core";

// Secure default for BLOB_MIME_ALLOWLIST. Derived from the shared raster-image
// allowlist (png/jpeg/webp/gif) + application/pdf so it can never drift from
// the icon allowlist or the download disposition logic. Deliberately an
// EXPLICIT list of full MIME types — NOT the bare `image/` prefix, which would
// also admit `image/svg+xml` (unnormalised, script-carrying → stored XSS).
export const DEFAULT_BLOB_MIME_ALLOWLIST_PARTS: readonly string[] = [
  ...RASTER_ICON_MIME_ALLOWLIST,
  "application/pdf",
];
export const DEFAULT_BLOB_MIME_ALLOWLIST =
  DEFAULT_BLOB_MIME_ALLOWLIST_PARTS.join(",");

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
  // Dedicated stricter limit for POST /v1/auth/request-link, keyed on BOTH the
  // client IP and the normalized target email (so a victim can't be bombed by
  // an attacker rotating IPs). Mirrors REGISTER_RATE_LIMIT. When the limit is
  // hit the endpoint still returns its usual 202 (no enumeration oracle) but
  // skips creating the MagicLink row + sending the email. =0 disables it.
  MAGIC_LINK_RATE_LIMIT: z.coerce.number().int().min(0).default(3),
  MAGIC_LINK_RATE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  // Dedicated, stricter per-IP limit for ANONYMOUS / public record mutations
  // (POST/PATCH/DELETE on /v1/panes/:id/records/:collection by a caller with
  // no agent/participant token and no login cookie — i.e. a public-pane guest).
  // Anonymous public writes are a spam surface (one shared `h_public` author,
  // no real human to attribute to), so they get a tighter bucket than the
  // general RATE_LIMIT. Authenticated writes (agent / participant / owner /
  // grantee) are NOT subject to this — they remain under the general limiter
  // only. Mirrors the WS per-connection anonymous-emit cap (ws/handler.ts).
  // =0 disables it (unlimited anonymous writes — not recommended).
  ANON_RECORD_WRITE_RATE_LIMIT: z.coerce.number().int().min(0).default(20),
  ANON_RECORD_WRITE_RATE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
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
  // Max concurrent WebSocket connections per pane/token.
  // MAX_WS_CONNECTIONS_PER_PANE=0 disables the cap.
  MAX_WS_CONNECTIONS_PER_PANE: z.coerce.number().int().min(0).default(16),
  // Max number of open (non-closed) panes a single agent may hold.
  // MAX_PANES_PER_AGENT=0 disables the cap.
  MAX_PANES_PER_AGENT: z.coerce.number().int().min(0).default(50),
  // Max number of events a single pane may accumulate.
  // MAX_EVENTS_PER_PANE=0 disables the cap.
  MAX_EVENTS_PER_PANE: z.coerce.number().int().min(0).default(10_000),
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
  // Usage-maturity gates keyed on a template's count of currently-open panes
  // (status=open AND deletedAt=null AND expiresAt>now, summed across all of
  // the template's versions). Both gate a template until it has proven a bit
  // of real use before it clutters a list or enters the public store.
  //   TEMPLATE_LIST_MIN_OPEN_PANES — GET /v1/templates (the author's own list,
  //     and the owner-shell "Yours" grid) hides a template with fewer than
  //     this many open panes. NOT applied to the ?include_deleted=true trash
  //     view. 0 disables the filter (every template lists).
  TEMPLATE_LIST_MIN_OPEN_PANES: z.coerce.number().int().min(0).default(2),
  //   TEMPLATE_PUBLISH_MIN_OPEN_PANES — the first publish to the public store
  //     (POST /v1/templates/:id/publish) is refused below this threshold. A
  //     re-publish of an already-published template (publishedAt set) skips
  //     the gate. 0 disables the gate (any template may publish).
  TEMPLATE_PUBLISH_MIN_OPEN_PANES: z.coerce.number().int().min(0).default(5),
  // F-11 — hard ceiling on how many published-template rows the public
  // catalog search will pull from the DB when resolving a tag-substring
  // match (the JSON `tags` array can't be substring-matched portably across
  // SQLite + Postgres, so the tag pass scans a bounded `{id, tags}`
  // projection rather than the whole table). name/description matches go
  // straight to SQL `contains` and are paginated; this cap only bounds the
  // tag-resolution pre-scan so the catalog can never materialise the entire
  // published set into memory regardless of how large it grows. 0 disables
  // the tag pass entirely (name/description search still works DB-side).
  TEMPLATE_SEARCH_SCAN_CAP: z.coerce.number().int().min(0).default(1_000),
  // Caps on the agent-supplied per-pane JSON Schema. The schema is compiled
  // by Ajv at pane-create / schema-patch time; an oversized or
  // pathologically-nested schema is a CPU sink, so both are bounded up front.
  MAX_SCHEMA_BYTES: z.coerce.number().int().positive().default(65_536),
  MAX_SCHEMA_DEPTH: z.coerce.number().int().positive().default(32),
  MAX_PARTICIPANTS_PER_PANE: z.coerce.number().int().positive().default(32),
  // #308 — pane lifecycle in three stages:
  //
  //   1. Active. expires_at > now(). Pane accepts events, listed in /my-*.
  //      Duration: caller-supplied ttl, or DEFAULT_TTL_SECONDS, capped at
  //      MAX_TTL_SECONDS.
  //   2. Soft-deleted. expires_at <= now(). The TTL sweeper (#303) sets
  //      `deleted_at = now()`. Pane is filtered from default queries but
  //      still listable in /v1/trash and restorable (#306). Duration depends
  //      on owner tier: free uses HARD_RETENTION_DAYS_FREE; paid uses
  //      HARD_RETENTION_DAYS_PAID (null = never).
  //   3. Hard-deleted. deleted_at + retention window elapsed. The hard-delete
  //      sweeper (#304) removes the row + cascades to children. An audit row
  //      stays in deletion_log indefinitely.
  //
  // 6 months default lifespan + 30 days trash window closes the "lost
  // baby-tracking pane" class of bug from 2026-05-30 (1h default expired
  // before the human could come back to read it).
  DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(15_768_000), // 180 days
  MAX_TTL_SECONDS: z.coerce.number().int().positive().default(31_536_000), // 1 year
  TTL_SWEEP_SECONDS: z.coerce.number().int().min(0).default(60),

  // #308 — hard-delete retention windows (days after `deleted_at` before
  // the hard-delete sweeper reclaims the row). Resolution per row, applied
  // by the sweeper from #304:
  //
  //   1. If `humans.hard_retention_days` is set, use it (per-row override).
  //   2. Else if `humans.tier = 'paid'`, use HARD_RETENTION_DAYS_PAID.
  //   3. Else (free, or no human owner), use HARD_RETENTION_DAYS_FREE.
  //   4. If `tier = 'system'` → never hard-delete (immune).
  //
  // HARD_RETENTION_DAYS_PAID defaults to `null` = never, on purpose: paid
  // users get effectively-permanent retention until/unless an operator sets
  // a different value. Storing null end-to-end (env unset, config unset,
  // sweeper skips) avoids a magic number masquerading as "no expiry."
  HARD_RETENTION_DAYS_FREE: z.coerce.number().int().positive().default(30),
  HARD_RETENTION_DAYS_PAID: z.coerce
    .number()
    .int()
    .positive()
    .nullable()
    .default(null),

  // How often the hard-delete sweeper wakes. 0 disables. Hourly is the
  // intended cadence — retention windows are days-scale, so an hour of
  // jitter on the actual reclaim time is fine.
  HARD_DELETE_SWEEP_SECONDS: z.coerce.number().int().min(0).default(3600),

  // ------------------------------------------------------------------
  // Records (#287)
  // ------------------------------------------------------------------
  // Max number of rows in one (pane, collection). Records replace the
  // comments-as-events anti-pattern at scale, so the ceiling is larger than
  // MAX_EVENTS_PER_PANE. MAX_RECORDS_PER_COLLECTION=0 disables the cap.
  MAX_RECORDS_PER_COLLECTION: z.coerce.number().int().min(0).default(50_000),
  // Per-row payload byte cap. Mirrors MAX_EVENT_DATA_BYTES.
  MAX_RECORD_DATA_BYTES: z.coerce.number().int().positive().default(65_536),
  // GET pagination cap (the route default is 100; this is the hard ceiling).
  MAX_RECORDS_PER_PAGE: z.coerce.number().int().positive().default(200),
  // Tombstone retention. A soft-deleted record stays in the table this long
  // so a client that disconnected at delete-time can observe the tombstone
  // on reconnect (a GET ?since=<seq> returns the row with deleted_at set).
  // After this TTL the row is hard-deleted by the sweeper.
  RECORD_TOMBSTONE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(604_800), // 7d
  // How often the tombstone sweeper wakes. 0 disables the sweeper.
  RECORD_SWEEPER_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .default(3_600), // 1h

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

  // Per-pane aggregate cap on attached attachments. 100 MB ≈ 20 max-size attachments.
  MAX_BLOBS_PER_PANE_BYTES: z.coerce
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
  // render). Smaller than pane by design — template assets should be
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
  // Pane-scope and template-scope attachments are NEVER evicted — they're
  // tied to a live pane / template and the cascade handles their
  // cleanup. When false, the relay rejects the upload with
  // quota_exceeded instead of evicting.
  BLOB_LRU_EVICTION: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => v === true || v === "true"),

  // Allowed MIME prefixes (matched as `mime.startsWith(prefix)`). Default is an
  // EXPLICIT raster-image + PDF list — deliberately NOT the bare `image/`
  // prefix, which would also match `image/svg+xml` (an XSS vector: SVG carries
  // inline <script>/event handlers and is not normalised). See
  // docs/SECURITY-POLYGLOTS.md.
  //
  // Comma-separated for the env var. An empty / unset value FALLS BACK to this
  // secure default — it does NOT disable the allowlist (an accidental empty
  // `BLOB_MIME_ALLOWLIST=` must never fail open and accept every type). To
  // intentionally accept any sniffed MIME (only sensible for a closed
  // self-host), set the single sentinel value `*`.
  BLOB_MIME_ALLOWLIST: z
    .string()
    .default(DEFAULT_BLOB_MIME_ALLOWLIST)
    .transform((s) => {
      const parts = s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      // Accidental-empty (`BLOB_MIME_ALLOWLIST=`) → secure default, never
      // accept-any. The explicit accept-any escape hatch is the `*` sentinel,
      // preserved verbatim and interpreted by isMimeAllowed().
      if (parts.length === 0) return [...DEFAULT_BLOB_MIME_ALLOWLIST_PARTS];
      return parts;
    }),

  // Default TTL for a /b/<token> capability URL minted against an
  // template-scope attachment. 30 days. Template-scope is the longest-lived; these
  // tokens are typically reused across many pane instances. Operators
  // tighten this if exposure tolerance is lower.
  BLOB_TOKEN_TTL_ARTIFACT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),

  // Default TTL for a /b/<token> capability URL minted against an agent-
  // scope attachment. 24 hours. Tightened from the original 7d design after the
  // security review (proposal #152) — long-lived agent tokens invited
  // "set and forget" leaks. Pane-scope tokens don't get a knob here:
  // they always inherit their pane's TTL exactly.
  BLOB_TOKEN_TTL_AGENT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60),

  // ------------------------------------------------------------------
  // Web Push / VAPID (optional — push notifications for logged-in humans)
  // ------------------------------------------------------------------
  // Generate a key pair once with: npx web-push generate-vapid-keys
  // Both keys are required together; if either is unset, push is disabled.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  // The mailto: or https: contact URL sent in the VAPID header. Required by
  // some push services; defaults to a localhost placeholder (fine for dev).
  VAPID_MAILTO: z.string().default("mailto:admin@localhost"),
  // Per-human push throttle window. The first pane-created notification fires
  // immediately; any further ones within this many seconds are coalesced into
  // a single "N new panes" message delivered when the window closes. Prevents a
  // busy agent from buzzing the human once per pane. Set to 0 to disable
  // coalescing and deliver every notification immediately.
  PUSH_COALESCE_WINDOW_SECONDS: z.coerce.number().int().min(0).default(60),

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
  // agent API and capability-URL panes, but POST /v1/auth/* returns 503.
  // Self-hosters who only need the agent pane leave this unset.
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

  // ---- Remote MCP connector (OAuth-protected Streamable-HTTP MCP) ----
  //
  // Mounts the MCP Streamable-HTTP endpoint at /mcp plus a self-hosted OAuth
  // 2.1 authorization server (DCR + PKCE) so a hosted MCP client (claude.ai /
  // Claude mobile) can add the relay as a custom connector. The issuer is the
  // relay's PUBLIC_URL; tokens map to a per-human Agent.
  //
  // Enabled by default. Disable to hide /mcp and the OAuth endpoints entirely
  // (e.g. a relay that only serves the CLI). The human-login + consent step
  // reuses the magic-link flow, so a relay with EMAIL_PROVIDER=none can still
  // expose initialize + tools/list (capability discovery is unauthenticated)
  // but a human can never complete consent — document this for self-hosters.
  MCP_HTTP_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Access-token TTL for the MCP OAuth flow. Short by design — a refresh token
  // (longer-lived, revocable) keeps the connector working. 1 hour default.
  MCP_OAUTH_ACCESS_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60),

  // Refresh-token TTL. 30 days mirrors the login cookie — disconnecting Claude
  // is a token revoke (the owner can do it without rotating their CLI key).
  MCP_OAUTH_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),

  // Authorization-code TTL. Single-use and consumed within seconds of the
  // redirect; 5 minutes is generous headroom for the round trip.
  MCP_OAUTH_CODE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60),

  // Dedicated per-IP rate limit for the OAuth endpoints (/oauth/register,
  // /oauth/authorize, /oauth/token, /oauth/revoke) and the unauthenticated
  // /mcp discovery path. These are mounted BEFORE the general /v1 limiter so
  // Claude's discovery probes aren't throttled by the agent-API limiter, which
  // also means they had NO per-IP bound at all — an open registration +
  // unbounded session creation surface. This limiter restores a bound without
  // affecting /v1. Generous enough for Claude's legitimate discovery burst
  // (a handful of well-known + register + authorize + token hits) but low
  // enough to stop a flood. =0 disables it (unlimited — not recommended).
  MCP_RATE_LIMIT: z.coerce.number().int().min(0).default(60),
  MCP_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  // Cap on the in-memory MCP session map (routes/mcp.ts). A session is created
  // on every `initialize`, which is UNAUTHENTICATED (capability discovery), so
  // without a cap an attacker can grow the map unboundedly (memory DoS). When
  // the map is full the oldest idle session is evicted to make room.
  // =0 disables the cap (unbounded — not recommended).
  MCP_MAX_SESSIONS: z.coerce.number().int().min(0).default(1000),
  // Idle TTL for an MCP session. A session untouched for this long is evicted
  // on the next sweep / insertion, so abandoned discovery sessions don't
  // linger. Must comfortably exceed a normal request gap.
  MCP_SESSION_IDLE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60),
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
  // #308 — DEFAULT_TTL_SECONDS must fit under MAX_TTL_SECONDS; otherwise the
  // implicit (no-ttl-supplied) pane-create path would silently produce a
  // pane that violates the cap.
  if (parsed.DEFAULT_TTL_SECONDS > parsed.MAX_TTL_SECONDS) {
    throw new ConfigError(
      "invalid relay configuration:\n" +
        `  - DEFAULT_TTL_SECONDS (${parsed.DEFAULT_TTL_SECONDS}) must be <= MAX_TTL_SECONDS (${parsed.MAX_TTL_SECONDS})`,
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
 * PUBLIC_URL: human-facing pane URLs are built from it. On Azure Container
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
      "PUBLIC_URL must be set in production — pane URLs are built from it. " +
        "On Azure Container Apps, set it to the ingress FQDN in a second deploy " +
        "step (https://<fqdn>). See docs/DEPLOY.md.",
    );
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(pub)) {
    throw new Error(
      `PUBLIC_URL still points at localhost (${pub}) in production — human-facing ` +
        "pane URLs would be unreachable. Set it to the public ingress URL. " +
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
  if (r.VAPID_PRIVATE_KEY) r.VAPID_PRIVATE_KEY = "<set>";
  if (typeof r.DATABASE_URL === "string") {
    // Mask userinfo (scheme://user:pass@host) ...
    let url = r.DATABASE_URL.replace(/:\/\/([^@/]+)@/, "://<redacted>@");
    // ... and any password-bearing query param (e.g. ?password=secret,
    // ?pwd=secret), which some drivers accept instead of inline userinfo.
    url = url.replace(/([?&](?:password|pwd|pass)=)[^&]*/gi, "$1<redacted>");
    r.DATABASE_URL = url;
  }
  if (typeof r.REDIS_URL === "string") {
    // Same userinfo-mask as DATABASE_URL. Azure Cache for Redis hands out
    // a rediss://:<base64-key>@host:6380 URL where the entire key sits in
    // the password slot. Without this mask the key was being logged in
    // cleartext via the "starting pane relay" config dump on boot. The
    // adjacent "redis enabled" log line already masks correctly — this
    // brings the config-dump path in line.
    r.REDIS_URL = r.REDIS_URL.replace(/:\/\/([^@/]+)@/, "://<redacted>@");
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
