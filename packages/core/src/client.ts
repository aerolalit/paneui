// Pane relay HTTP client. Pure: no argv, no process.env reads, no MCP.
// The caller supplies the relay base URL + API key explicitly.

import type {
  TemplateRecord,
  TemplateSummary,
  TemplateType,
  TemplateVersion,
  CreateArtifactResponse,
  CreatePaneRequest,
  CreatePaneResponse,
  EventsPage,
  FeedbackPage,
  FeedbackSubmission,
  FeedbackType,
  KeyInfo,
  MintParticipantResponse,
  PaneEvent,
  ParticipantsList,
  SerializedRecord,
  PaneState,
  PanesPage,
  TasteInfo,
  TrashListResponse,
} from "./types.js";
import type { ListPanesQuery } from "./schemas.js";
import { MAX_RESPONSE_SNIPPET_LENGTH } from "./limits.js";

export interface ClientOptions {
  /** Relay base URL, e.g. https://pane.example.com. Trailing slash is trimmed. */
  url: string;
  /** Agent API key (bearer token). */
  apiKey: string;
  /** Optional fetch override (defaults to global fetch). */
  fetch?: typeof fetch;
  /**
   * Optional client version string sent as `x-pane-cli-version` on every
   * request. The CLI passes its own `VERSION` constant here so a relay can
   * detect version skew and respond with a `cli_upgrade_required` error
   * (HTTP 426) when the CLI is below the relay's minimum supported version.
   * Library callers (non-CLI) can leave this unset — the header is omitted
   * and the relay treats the request as version-unknown.
   */
  cliVersion?: string;
}

/** Low-level relay response: ok flag, HTTP status, parsed JSON body. */
export interface RelayResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

/**
 * Request body for POST /v1/templates — create a named, reusable template plus
 * its v1 content. Mirrors `createArtifactSchema` from ./schemas.js.
 */
/** Response from POST /v1/query. */
export interface QueryResponse {
  /** Ordered column names exactly as DuckDB returned them. */
  columns: string[];
  /** Result rows; each row is an array of values aligned to `columns`. */
  rows: unknown[][];
  /** True if the result was capped by the relay's per-query row cap. */
  truncated: boolean;
  /** Tells the caller which panes the query saw and how it was scoped. */
  scope: { kind: "human" | "agent"; pane_count: number };
  /** Wall-clock milliseconds the relay spent serving the query. */
  elapsed_ms: number;
}

export interface CreateArtifactRequest {
  name: string;
  slug?: string;
  description?: string;
  tags?: string[];
  source: string;
  type: TemplateType;
  event_schema?: unknown;
  input_schema?: Record<string, unknown>;
  /** Optional template icon emoji (a single emoji grapheme). Image icons are
   *  set post-create via `updateArtifact({ icon_attachment_id })`. */
  icon_emoji?: string;
}

/**
 * Request body for POST /v1/templates/:id/versions — append a new immutable
 * version (content only). Mirrors `createArtifactVersionSchema`.
 */
export interface CreateArtifactVersionRequest {
  source: string;
  type: TemplateType;
  event_schema?: unknown;
  input_schema?: Record<string, unknown>;
}

/**
 * Request body for PATCH /v1/templates/:id — head metadata only (never
 * content). Mirrors `patchArtifactMetadataSchema`.
 */
export interface PatchArtifactMetadataRequest {
  name?: string;
  slug?: string;
  description?: string;
  tags?: string[];
  /** Set a single-grapheme emoji icon, or `null` to clear it. */
  icon_emoji?: string | null;
  /** Set the icon to a ready, template-scoped raster image attachment, or
   *  `null` to clear it. */
  icon_attachment_id?: string | null;
}

/** One identity-share grant as returned by the grants endpoints. */
export interface PaneGrant {
  id: string;
  /** Set once the invitee logs in and the grant binds; null while pending. */
  human_id: string | null;
  /** The invited email, or null for a grant created directly against a human. */
  invite_email: string | null;
  /** "participant" (read + emit) | "viewer" (read-only). */
  role: string;
  /** ISO timestamp the grant was bound to a human, or null while pending. */
  accepted_at: string | null;
}

/**
 * The pane-id (`/p/:paneId`) access mode. Governs ONLY the pane-id path; token
 * (`/s/<token>`) links are unaffected and keep working in every mode.
 *   - "invite_only" — only invited emails (after login) may open /p.
 *   - "link"        — anyone with the /p URL opens it read-only, no login.
 *   - "public"      — anyone opens it read-only, no login (discovery TBD).
 */
export type AccessMode = "invite_only" | "link" | "public";

/** Response from GET /v1/panes/:id/grants. */
export interface PaneGrantsList {
  pane_id: string;
  access_mode: AccessMode;
  items: PaneGrant[];
}

/** Response from PATCH /v1/panes/:id/visibility. */
export interface PaneVisibility {
  pane_id: string;
  access_mode: AccessMode;
}

/**
 * An error thrown by the typed operations when the relay returns a non-2xx
 * response (or the request fails outright). Carries the HTTP status and the
 * relay error envelope so callers can branch on `code`.
 */
export class PaneApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** Agent-friendly remediation hint, when the relay supplies one. */
  readonly hint?: string;
  /** Whether retrying the same request may succeed (e.g. 429). */
  readonly retryable?: boolean;
  /** Documentation URL for this error class (mapped from the wire's `docs_url`). */
  readonly docsUrl?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    extra?: { hint?: string; retryable?: boolean; docsUrl?: string },
  ) {
    super(message);
    this.name = "PaneApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = extra?.hint;
    this.retryable = extra?.retryable;
    this.docsUrl = extra?.docsUrl;
  }
}

export class PaneClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cliVersion: string | undefined;

  constructor(opts: ClientOptions) {
    this.base = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.cliVersion = opts.cliVersion;
  }

  /** Relay base URL (trailing slash trimmed). */
  get baseUrl(): string {
    return this.base;
  }

  /** WebSocket base URL derived from the relay base URL (http→ws, https→wss). */
  get wsBaseUrl(): string {
    const u = new URL(this.base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString().replace(/\/$/, "");
  }

  /**
   * Low-level HTTP helper. Mirrors the relay API contract: Bearer auth,
   * JSON bodies, 204 handled. Never throws on non-2xx — returns `ok: false`.
   * Network failures return `{ ok: false, status: 0, ... }`.
   */
  async call(
    method: string,
    path: string,
    body?: object,
  ): Promise<RelayResponse> {
    const url = this.base + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: "Bearer " + this.apiKey,
          ...(body ? { "content-type": "application/json" } : {}),
          // x-pane-cli-version drives the relay's version-skew check. Header
          // is omitted entirely when no version was supplied so the relay
          // can distinguish "old CLI" from "non-CLI caller".
          ...(this.cliVersion ? { "x-pane-cli-version": this.cliVersion } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        status: 0,
        data: { error: { code: "fetch_error", message: msg } },
      };
    }
    let data: unknown = null;
    if (res.status !== 204) {
      const text = await res.text().catch(() => "");
      if (text !== "") {
        try {
          data = JSON.parse(text);
        } catch {
          // Body was not JSON (HTML error page, plain-text proxy error, …).
          // Don't discard it — pane the raw text so callers can diagnose.
          const snippet =
            text.length > MAX_RESPONSE_SNIPPET_LENGTH
              ? text.slice(0, MAX_RESPONSE_SNIPPET_LENGTH) + "…"
              : text;
          data = {
            error: {
              code: "non_json_response",
              message: `relay returned a non-JSON body (status ${res.status})`,
              details: { body: snippet },
            },
          };
        }
      }
    }
    return { ok: res.ok, status: res.status, data };
  }

  /** Assert a 2xx body is a non-null object before treating it as typed JSON. */
  private asObject<T>(r: RelayResponse): T {
    if (
      r.data === null ||
      typeof r.data !== "object" ||
      Array.isArray(r.data)
    ) {
      throw new PaneApiError(
        r.status,
        "invalid_response",
        `relay returned a ${r.status} with a non-object body`,
        { body: r.data },
      );
    }
    return r.data as T;
  }

  /** Throw a PaneApiError from a failed RelayResponse. */
  private fail(r: RelayResponse): never {
    const err = (
      r.data as {
        error?: {
          code?: string;
          message?: string;
          details?: unknown;
          hint?: string;
          retryable?: boolean;
          docs_url?: string;
        };
      } | null
    )?.error;
    throw new PaneApiError(
      r.status,
      err?.code ?? "relay_error",
      err?.message ?? `relay returned ${r.status}`,
      err?.details,
      {
        hint: err?.hint,
        retryable: err?.retryable,
        docsUrl: err?.docs_url,
      },
    );
  }

  /** POST /v1/panes — create a pane. */
  async createPane(req: CreatePaneRequest): Promise<CreatePaneResponse> {
    const r = await this.call("POST", "/v1/panes", {
      template: req.template,
      title: req.title,
      preamble: req.preamble,
      input_data: req.input_data,
      participants: req.participants,
      ttl: req.ttl,
      metadata: req.metadata,
      callback: req.callback,
      context_key: req.context_key,
      icon_emoji: req.icon_emoji,
      icon_attachment_id: req.icon_attachment_id,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<CreatePaneResponse>(r);
  }

  /** GET /v1/panes/:id — non-blocking pane metadata. */
  async getPane(paneId: string): Promise<PaneState> {
    const r = await this.call("GET", `/v1/panes/${encodeURIComponent(paneId)}`);
    if (!r.ok) this.fail(r);
    return this.asObject<PaneState>(r);
  }

  /**
   * GET /v1/panes/:id/events — fetch the event log.
   * `since` is an opaque cursor; `waitSeconds` enables the relay long-poll
   * (0 = non-blocking, capped at 30 by the relay).
   */
  async getEvents(
    paneId: string,
    opts: { since?: string | null; waitSeconds?: number } = {},
  ): Promise<EventsPage> {
    const q = new URLSearchParams();
    if (opts.since != null && opts.since !== "") q.set("since", opts.since);
    if (opts.waitSeconds != null && opts.waitSeconds > 0) {
      q.set("wait", String(Math.floor(opts.waitSeconds)));
    }
    const qs = q.toString();
    const r = await this.call(
      "GET",
      `/v1/panes/${encodeURIComponent(paneId)}/events${qs ? "?" + qs : ""}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<EventsPage>(r);
  }

  // ----- #355: SQL query API --------------------------------------------

  /**
   * POST /v1/query — run a read-only SQL query against the agent's own
   * scoped data (panes, records, events). The relay scopes the result at
   * the view layer; the agent can never see rows whose pane.owner_human_id
   * does not match the caller's scope. Three generic views (panes, records,
   * events) are always exposed; per-collection / per-event-type views are
   * also materialized for any schemas declared on the caller's templates.
   *
   * `opts.paneId` narrows the scope to a single pane — handy when two of
   * the caller's panes declare the same collection with incompatible types
   * and the materializer would otherwise raise view_conflict.
   *
   * `data` is a JSON column — use Postgres-style operators (->>, ->) to
   * project into it. Cap: 10,000 result rows (response.truncated=true
   * signals the cap was hit); statement timeout: 10 seconds.
   */
  async query(
    sql: string,
    opts: { paneId?: string } = {},
  ): Promise<QueryResponse> {
    const body: { sql: string; pane_id?: string } = { sql };
    if (opts.paneId !== undefined) body.pane_id = opts.paneId;
    const r = await this.call("POST", "/v1/query", body);
    if (!r.ok) this.fail(r);
    return this.asObject<QueryResponse>(r);
  }

  // ----- #297: records CRUD ---------------------------------------------

  /**
   * GET /v1/panes/:id/records/:collection — cursor-paginated list.
   * Includes tombstones (`deleted_at` set) so reconnecting clients can
   * observe deletions.
   */
  async listRecords(
    paneId: string,
    collection: string,
    opts: { since?: number; limit?: number } = {},
  ): Promise<{
    records: SerializedRecord[];
    next_since: number;
    has_more: boolean;
  }> {
    const q = new URLSearchParams();
    if (opts.since != null) q.set("since", String(opts.since));
    if (opts.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    const r = await this.call(
      "GET",
      `/v1/panes/${encodeURIComponent(paneId)}/records/${encodeURIComponent(collection)}${qs ? "?" + qs : ""}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject(r);
  }

  /**
   * Convenience: walk listRecords until the named recordKey is found OR
   * the collection is exhausted. The relay has no dedicated single-get
   * route today; this client-side scan trades round trips for not adding
   * a route. Fine for typical CLI use; not appropriate for hot paths.
   */
  async getRecord(
    paneId: string,
    collection: string,
    recordKey: string,
  ): Promise<SerializedRecord | null> {
    let since: number | undefined;
    for (;;) {
      const page = await this.listRecords(paneId, collection, {
        since,
        limit: 200,
      });
      const hit = page.records.find((r) => r.key === recordKey);
      if (hit) return hit;
      if (!page.has_more) return null;
      since = page.next_since;
    }
  }

  /**
   * POST /v1/panes/:id/records/:collection — create-or-return-existing.
   * Duplicate `recordKey` returns the existing row with `deduped: true`.
   */
  async upsertRecord(
    paneId: string,
    collection: string,
    body: { record_key?: string; data: unknown },
  ): Promise<{ record: SerializedRecord; deduped: boolean }> {
    const r = await this.call(
      "POST",
      `/v1/panes/${encodeURIComponent(paneId)}/records/${encodeURIComponent(collection)}`,
      body,
    );
    if (!r.ok) this.fail(r);
    const out = this.asObject<{
      record: SerializedRecord;
      deduped?: boolean;
    }>(r);
    return { record: out.record, deduped: out.deduped ?? false };
  }

  /**
   * PATCH /v1/panes/:id/records/:collection/:recordKey — optimistic
   * update. On 409 the relay returns the current row in `details.current`.
   */
  async updateRecord(
    paneId: string,
    collection: string,
    recordKey: string,
    body: { data: unknown; if_match?: number },
  ): Promise<{ record: SerializedRecord }> {
    const r = await this.call(
      "PATCH",
      `/v1/panes/${encodeURIComponent(paneId)}/records/${encodeURIComponent(collection)}/${encodeURIComponent(recordKey)}`,
      body,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ record: SerializedRecord }>(r);
  }

  /**
   * DELETE /v1/panes/:id/records/:collection/:recordKey — soft-delete.
   * Optional `if_match` returns 409 + `details.current` on mismatch.
   */
  async deleteRecord(
    paneId: string,
    collection: string,
    recordKey: string,
    opts: { ifMatch?: number } = {},
  ): Promise<void> {
    const body = opts.ifMatch != null ? { if_match: opts.ifMatch } : undefined;
    const r = await this.call(
      "DELETE",
      `/v1/panes/${encodeURIComponent(paneId)}/records/${encodeURIComponent(collection)}/${encodeURIComponent(recordKey)}`,
      body,
    );
    if (!r.ok) this.fail(r);
  }

  // ----- template-level records CRUD ------------------------------------

  /**
   * GET /v1/templates/:id/template-records/:collection — owner-only list of
   * a template's curated records. Same wire shape as listRecords, separate
   * route so the relay can route owner-vs-page access independently.
   */
  async listTemplateRecords(
    templateIdOrSlug: string,
    collection: string,
    opts: { since?: number; limit?: number } = {},
  ): Promise<{
    records: SerializedRecord[];
    next_since: number;
    has_more: boolean;
  }> {
    const q = new URLSearchParams();
    if (opts.since != null) q.set("since", String(opts.since));
    if (opts.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    const r = await this.call(
      "GET",
      `/v1/templates/${encodeURIComponent(templateIdOrSlug)}/template-records/${encodeURIComponent(collection)}${qs ? "?" + qs : ""}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject(r);
  }

  /**
   * Client-side scan helper — same shape as `getRecord` but for template
   * records. Walks listTemplateRecords until the key matches.
   */
  async getTemplateRecord(
    templateIdOrSlug: string,
    collection: string,
    recordKey: string,
  ): Promise<SerializedRecord | null> {
    let since: number | undefined;
    for (;;) {
      const page = await this.listTemplateRecords(
        templateIdOrSlug,
        collection,
        { since, limit: 200 },
      );
      const hit = page.records.find((r) => r.key === recordKey);
      if (hit) return hit;
      if (!page.has_more) return null;
      since = page.next_since;
    }
  }

  /**
   * POST /v1/templates/:id/template-records/:collection — owner-only
   * create-or-return-existing.
   */
  async upsertTemplateRecord(
    templateIdOrSlug: string,
    collection: string,
    body: { record_key?: string; data: unknown },
  ): Promise<{ record: SerializedRecord; deduped: boolean }> {
    const r = await this.call(
      "POST",
      `/v1/templates/${encodeURIComponent(templateIdOrSlug)}/template-records/${encodeURIComponent(collection)}`,
      body,
    );
    if (!r.ok) this.fail(r);
    const out = this.asObject<{
      record: SerializedRecord;
      deduped?: boolean;
    }>(r);
    return { record: out.record, deduped: out.deduped ?? false };
  }

  /**
   * PATCH /v1/templates/:id/template-records/:collection/:recordKey —
   * optimistic-locked update.
   */
  async updateTemplateRecord(
    templateIdOrSlug: string,
    collection: string,
    recordKey: string,
    body: { data: unknown; if_match?: number },
  ): Promise<{ record: SerializedRecord }> {
    const r = await this.call(
      "PATCH",
      `/v1/templates/${encodeURIComponent(templateIdOrSlug)}/template-records/${encodeURIComponent(collection)}/${encodeURIComponent(recordKey)}`,
      body,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ record: SerializedRecord }>(r);
  }

  /**
   * DELETE /v1/templates/:id/template-records/:collection/:recordKey —
   * soft-delete.
   */
  async deleteTemplateRecord(
    templateIdOrSlug: string,
    collection: string,
    recordKey: string,
    opts: { ifMatch?: number } = {},
  ): Promise<void> {
    const body = opts.ifMatch != null ? { if_match: opts.ifMatch } : undefined;
    const r = await this.call(
      "DELETE",
      `/v1/templates/${encodeURIComponent(templateIdOrSlug)}/template-records/${encodeURIComponent(collection)}/${encodeURIComponent(recordKey)}`,
      body,
    );
    if (!r.ok) this.fail(r);
  }

  /** POST /v1/panes/:id/events — append an agent event. */
  async sendEvent(
    paneId: string,
    ev: {
      type: string;
      data: unknown;
      causationId?: string;
      idempotencyKey?: string;
    },
  ): Promise<{ event: PaneEvent; deduped: boolean }> {
    const r = await this.call(
      "POST",
      `/v1/panes/${encodeURIComponent(paneId)}/events`,
      {
        type: ev.type,
        data: ev.data,
        causation_id: ev.causationId,
        idempotency_key: ev.idempotencyKey,
      },
    );
    if (!r.ok) this.fail(r);
    const body = this.asObject<{ event: PaneEvent; deduped?: boolean }>(r);
    return { event: body.event, deduped: body.deduped ?? false };
  }

  /**
   * POST /v1/templates — create a named, reusable template and its v1 content.
   * Returns the new `template_id` and `version` (1).
   */
  async createArtifact(
    req: CreateArtifactRequest,
  ): Promise<CreateArtifactResponse> {
    const r = await this.call("POST", "/v1/templates", {
      name: req.name,
      slug: req.slug,
      description: req.description,
      tags: req.tags,
      source: req.source,
      type: req.type,
      event_schema: req.event_schema,
      input_schema: req.input_schema,
      icon_emoji: req.icon_emoji,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<CreateArtifactResponse>(r);
  }

  /**
   * POST /v1/templates/:id/versions — append a new immutable version to an
   * existing template. `idOrSlug` accepts the template id or its slug.
   * Returns the new `version` number.
   */
  async createArtifactVersion(
    idOrSlug: string,
    req: CreateArtifactVersionRequest,
  ): Promise<CreateArtifactResponse> {
    const r = await this.call(
      "POST",
      `/v1/templates/${encodeURIComponent(idOrSlug)}/versions`,
      {
        source: req.source,
        type: req.type,
        event_schema: req.event_schema,
        input_schema: req.input_schema,
      },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<CreateArtifactResponse>(r);
  }

  /**
   * PATCH /v1/templates/:id — update head metadata (name / slug / description /
   * tags); never the content. Returns the updated lean summary.
   */
  async updateArtifact(
    idOrSlug: string,
    metadata: PatchArtifactMetadataRequest,
  ): Promise<TemplateSummary> {
    const r = await this.call(
      "PATCH",
      `/v1/templates/${encodeURIComponent(idOrSlug)}`,
      {
        name: metadata.name,
        slug: metadata.slug,
        description: metadata.description,
        tags: metadata.tags,
        // Forward null explicitly (clears the icon); undefined is dropped by
        // JSON.stringify so an omitted field is a no-op server-side.
        icon_emoji: metadata.icon_emoji,
        icon_attachment_id: metadata.icon_attachment_id,
      },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<TemplateSummary>(r);
  }

  /**
   * GET /v1/templates?q=... — search/list the agent's named templates. The
   * response is lean (no `source` attachment), ranked by `last_used_at`. Omit `query`
   * to list every named template.
   */
  async searchArtifacts(query?: string): Promise<TemplateSummary[]> {
    const qs =
      query != null && query !== "" ? "?q=" + encodeURIComponent(query) : "";
    const r = await this.call("GET", `/v1/templates${qs}`);
    if (!r.ok) this.fail(r);
    return this.asObject<{ templates: TemplateSummary[] }>(r).templates;
  }

  /**
   * GET /v1/templates/:id — fetch a full template (head metadata + version
   * list). `idOrSlug` accepts the template id or its slug.
   */
  async getArtifact(idOrSlug: string): Promise<TemplateRecord> {
    const r = await this.call(
      "GET",
      `/v1/templates/${encodeURIComponent(idOrSlug)}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<TemplateRecord>(r);
  }

  /**
   * GET /v1/templates/:id/versions/:version — fetch one version's full
   * content (HTML, event schema, input schema).
   */
  async getArtifactVersion(
    idOrSlug: string,
    version: number,
  ): Promise<TemplateVersion> {
    const r = await this.call(
      "GET",
      `/v1/templates/${encodeURIComponent(idOrSlug)}/versions/${encodeURIComponent(String(version))}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<TemplateVersion>(r);
  }

  /**
   * GET /v1/keys — the calling agent's own key info. The relay scopes this to
   * the authenticated agent: it returns one key (the caller's), not a list.
   */
  async listKeys(): Promise<KeyInfo> {
    const r = await this.call("GET", "/v1/keys");
    if (!r.ok) this.fail(r);
    return this.asObject<KeyInfo>(r);
  }

  /**
   * DELETE /v1/keys/:id — revoke an API key. The relay only permits revoking
   * the caller's OWN key (any other id is rejected 403): this is a
   * self-destruct. Returns 204 with no body on success.
   */
  async revokeKey(id: string): Promise<void> {
    const r = await this.call("DELETE", `/v1/keys/${encodeURIComponent(id)}`);
    if (!r.ok) this.fail(r);
  }

  /**
   * POST /v1/agents/claim — bind this agent to a human via a one-shot
   * claim code the human generated in their settings UI. After a
   * successful claim the agent's existing API key continues to work,
   * but the agent (and its panes/templates) now belong to the
   * claiming human. One-way operation — there is no unclaim in v1.
   */
  async claimAgent(
    code: string,
  ): Promise<{ ok: true; owner_human_id: string; claimed_at: string }> {
    const r = await this.call("POST", "/v1/agents/claim", { code });
    if (!r.ok) this.fail(r);
    return this.asObject<{
      ok: true;
      owner_human_id: string;
      claimed_at: string;
    }>(r);
  }

  /**
   * GET /v1/taste — the calling agent's freeform "taste notes" markdown attachment:
   * presentation preferences the agent has picked up from human feedback over
   * time. Returns `{ taste: null, updated_at: null, bytes: 0 }` when the
   * agent has never written notes. Read this before generating an template so
   * the agent applies prior feedback.
   */
  async getTaste(): Promise<TasteInfo> {
    const r = await this.call("GET", "/v1/taste");
    if (!r.ok) this.fail(r);
    return this.asObject<TasteInfo>(r);
  }

  /**
   * PUT /v1/taste — whole-attachment replace of the calling agent's taste notes.
   * Empty/whitespace-only values are rejected by the relay; callers asking to
   * clear must use {@link clearTaste}. The relay caps the payload at the
   * server's `MAX_TASTE_BYTES` (utf8 bytes).
   */
  async setTaste(taste: string): Promise<TasteInfo> {
    const r = await this.call("PUT", "/v1/taste", { taste });
    if (!r.ok) this.fail(r);
    return this.asObject<TasteInfo>(r);
  }

  /**
   * DELETE /v1/taste — clear the calling agent's taste notes (idempotent on
   * the relay; clearing already-empty notes still succeeds). Returns 204 with
   * no body.
   */
  async clearTaste(): Promise<void> {
    const r = await this.call("DELETE", "/v1/taste");
    if (!r.ok) this.fail(r);
  }

  /**
   * POST /v1/feedback — submit a one-shot bug report, feature request, or
   * note to the relay operator. Returns the new row's id, type, and
   * created_at; the message is not echoed.
   */
  async submitFeedback(req: {
    type: FeedbackType;
    message: string;
    paneId?: string;
  }): Promise<FeedbackSubmission> {
    const r = await this.call("POST", "/v1/feedback", {
      type: req.type,
      message: req.message,
      pane_id: req.paneId,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<FeedbackSubmission>(r);
  }

  /**
   * GET /v1/feedback — the calling agent's own submissions, newest first.
   * `before` is an opaque cursor from a previous page's `next_before`.
   */
  async listFeedback(
    opts: { limit?: number; before?: string } = {},
  ): Promise<FeedbackPage> {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.before != null && opts.before !== "") q.set("before", opts.before);
    const qs = q.toString();
    const r = await this.call("GET", `/v1/feedback${qs ? "?" + qs : ""}`);
    if (!r.ok) this.fail(r);
    return this.asObject<FeedbackPage>(r);
  }

  /**
   * GET /v1/panes — list the calling agent's panes. Default filter is
   * `status=open` (effective status — respects expiresAt). Response items
   * carry NO secrets: no participant token plaintext, no callback URL, no
   * metadata or input_data. Use `participant_id` from the list as the handle
   * for {@link revokeParticipant}; use {@link mintParticipant} to issue a
   * fresh URL when the original was lost.
   */
  async listPanes(opts: ListPanesQuery = {}): Promise<PanesPage> {
    const q = new URLSearchParams();
    if (opts.status !== undefined) q.set("status", opts.status);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.cursor !== undefined && opts.cursor !== "")
      q.set("cursor", opts.cursor);
    if (opts.template_id !== undefined && opts.template_id !== "")
      q.set("template_id", opts.template_id);
    const qs = q.toString();
    const r = await this.call("GET", `/v1/panes${qs ? "?" + qs : ""}`);
    if (!r.ok) this.fail(r);
    return this.asObject<PanesPage>(r);
  }

  /**
   * GET /v1/panes/:id/participants — list every participant on one
   * pane (active and revoked). Bounded by MAX_PARTICIPANTS_PER_PANE
   * on the relay, so the full list is returned with no pagination.
   * Use this to find the `participant_id` you need to pass to
   * {@link revokeParticipant}, or to audit revoked rows.
   */
  async listParticipants(paneId: string): Promise<ParticipantsList> {
    const r = await this.call(
      "GET",
      `/v1/panes/${encodeURIComponent(paneId)}/participants`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<ParticipantsList>(r);
  }

  /**
   * POST /v1/panes/:id/participants — mint a fresh participant URL for an
   * existing pane. The one-shot recovery primitive when the original URL
   * was dropped: the pane keeps its event log, template pin, and created_at.
   * v1 supports `kind: "human"` only.
   *
   * The plaintext token is returned EXACTLY ONCE in the response — the relay
   * stores only the hash. Save the response (e.g. pipe to a JSONL log) before
   * delivering the URL to the human.
   */
  async mintParticipant(
    paneId: string,
    opts: { kind?: "human" } = {},
  ): Promise<MintParticipantResponse> {
    const r = await this.call(
      "POST",
      `/v1/panes/${encodeURIComponent(paneId)}/participants`,
      { kind: opts.kind ?? "human" },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<MintParticipantResponse>(r);
  }

  /**
   * DELETE /v1/panes/:id/participants/:participant_id — revoke a single
   * participant URL. The pane's other participants (and the agent's own
   * WebSocket) are untouched. Idempotent: revoking an unknown or already-
   * revoked participant returns 204. The agent participant cannot be revoked
   * via this endpoint — use {@link deletePane} instead.
   *
   * Existing WebSocket connections held under the revoked token are NOT
   * actively kicked in v1; new HTTP and WS connections are refused.
   */
  async revokeParticipant(
    paneId: string,
    participantId: string,
  ): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/panes/${encodeURIComponent(paneId)}/participants/${encodeURIComponent(participantId)}`,
    );
    if (!r.ok) this.fail(r);
  }

  /**
   * GET /v1/panes/:id/grants — list the pane's identity-share grants plus
   * its current `access_mode`. Owner/agent-scope only.
   */
  async listGrants(paneId: string): Promise<PaneGrantsList> {
    const r = await this.call(
      "GET",
      `/v1/panes/${encodeURIComponent(paneId)}/grants`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<PaneGrantsList>(r);
  }

  /**
   * POST /v1/panes/:id/grants — invite a human by email. Upserts by email,
   * so re-inviting the same address adjusts the role in place. Role defaults
   * to "participant" (read + emit); pass "viewer" for read-only.
   */
  async createGrant(
    paneId: string,
    opts: { email: string; role?: "participant" | "viewer" },
  ): Promise<PaneGrant> {
    const r = await this.call(
      "POST",
      `/v1/panes/${encodeURIComponent(paneId)}/grants`,
      opts.role
        ? { email: opts.email, role: opts.role }
        : { email: opts.email },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<PaneGrant>(r);
  }

  /**
   * DELETE /v1/panes/:id/grants/:grantId — revoke one grant. Idempotent: a
   * missing/already-removed grant returns 204.
   */
  async revokeGrant(paneId: string, grantId: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/panes/${encodeURIComponent(paneId)}/grants/${encodeURIComponent(grantId)}`,
    );
    if (!r.ok) this.fail(r);
  }

  /**
   * PATCH /v1/panes/:id/visibility — set the pane's /p access mode.
   *   - "invite_only" — only invited emails (after login) may open /p.
   *   - "link"        — anyone with the /p URL opens it READ-ONLY, no login.
   *   - "public"      — anyone opens it READ-ONLY, no login (discovery TBD).
   * Token (`/s/<token>`) links are independent of this and keep working.
   */
  async setPaneVisibility(
    paneId: string,
    accessMode: AccessMode,
  ): Promise<PaneVisibility> {
    const r = await this.call(
      "PATCH",
      `/v1/panes/${encodeURIComponent(paneId)}/visibility`,
      { access_mode: accessMode },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<PaneVisibility>(r);
  }

  /**
   * DELETE /v1/panes/:id — close/delete a pane. Idempotent on the relay
   * side (an already-closed pane still returns 204 with no body).
   */
  async deletePane(id: string): Promise<void> {
    const r = await this.call("DELETE", `/v1/panes/${encodeURIComponent(id)}`);
    if (!r.ok) this.fail(r);
  }

  /**
   * GET /v1/trash — list soft-deleted panes + templates in the caller's
   * agent-scope. The trash UI / `pane trash list` lives off this. (#306)
   */
  async listTrash(): Promise<TrashListResponse> {
    const r = await this.call("GET", "/v1/trash");
    if (!r.ok) this.fail(r);
    return r.data as TrashListResponse;
  }

  /**
   * POST /v1/trash/panes/:id/restore — un-trash a soft-deleted pane (clear
   * deletedAt + audit row). (#306)
   */
  async restorePane(id: string): Promise<void> {
    const r = await this.call(
      "POST",
      `/v1/trash/panes/${encodeURIComponent(id)}/restore`,
    );
    if (!r.ok) this.fail(r);
  }

  /**
   * POST /v1/trash/templates/:id/restore — un-trash a soft-deleted template. (#306)
   */
  async restoreTemplate(id: string): Promise<void> {
    const r = await this.call(
      "POST",
      `/v1/trash/templates/${encodeURIComponent(id)}/restore`,
    );
    if (!r.ok) this.fail(r);
  }

  /**
   * DELETE /v1/trash/panes/:id — permanently hard-delete a trashed pane
   * (bypass retention window). (#306)
   */
  async permanentDeletePane(id: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/trash/panes/${encodeURIComponent(id)}`,
    );
    if (!r.ok) this.fail(r);
  }

  /**
   * DELETE /v1/trash/templates/:id — permanently hard-delete a trashed
   * template. Refused 409 if a live pane still references one of its
   * versions. (#306)
   */
  async permanentDeleteTemplate(id: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/trash/templates/${encodeURIComponent(id)}`,
    );
    if (!r.ok) this.fail(r);
  }

  /**
   * DELETE /v1/templates/:id — remove an template and (server-side) all its
   * versions. Strict cascade: the relay refuses with 409 conflict if any
   * pane in any state still references one of the template's versions —
   * pane that as a typed PaneApiError so the CLI can render a hint
   * instead of swallowing it.
   */
  async deleteArtifact(idOrSlug: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/templates/${encodeURIComponent(idOrSlug)}`,
    );
    if (!r.ok) this.fail(r);
  }

  /**
   * POST /v1/templates/:id/publish — enter the public catalog. The optional
   * `scopes` list locks the permissions the template will request from
   * installers at this version (see Phase F §4.5 / §8). Passing an empty
   * array clears the stored scopes; omitting `scopes` keeps the existing
   * ones.
   */
  async publishTemplate(
    idOrSlug: string,
    body: { scopes?: string[] } = {},
  ): Promise<{
    id: string;
    slug: string | null;
    name: string | null;
    published_at: string | null;
    scopes: string[];
    install_count: number;
  }> {
    const r = await this.call(
      "POST",
      `/v1/templates/${encodeURIComponent(idOrSlug)}/publish`,
      body,
    );
    if (!r.ok) this.fail(r);
    return this.asObject(r);
  }

  /**
   * POST /v1/templates/:id/unpublish — leave the public catalog. Existing
   * installs are unaffected (humans keep their pinned version), but the
   * template no longer appears in `searchPublicTemplates` results.
   */
  async unpublishTemplate(
    idOrSlug: string,
  ): Promise<{ id: string; published_at: string | null }> {
    const r = await this.call(
      "POST",
      `/v1/templates/${encodeURIComponent(idOrSlug)}/unpublish`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject(r);
  }

  /**
   * GET /v1/templates/catalog?q=... — agent-side public catalog search.
   * Lets an agent discover already-published apps before authoring a
   * duplicate. Sorted by install_count desc, then publish recency.
   */
  async searchPublicTemplates(
    query?: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{
    items: Array<{
      id: string;
      slug: string | null;
      name: string | null;
      description: string | null;
      tags: string[] | null;
      shape: string;
      scopes: string[];
      published_at: string | null;
      install_count: number;
      latest_version: number;
    }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    const params = new URLSearchParams();
    if (query != null && query !== "") params.set("q", query);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString();
    const r = await this.call(
      "GET",
      `/v1/templates/catalog${qs ? "?" + qs : ""}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject(r);
  }

  // ------------------------------------------------------------------------
  // Blobs (v0.1.0). Three-scope binary attachments with multipart upload.
  // See proposal pane#152 for the full design.
  // ------------------------------------------------------------------------

  /**
   * Upload a attachment to the relay. Returns a `AttachmentRef` that can be referenced
   * in event payloads (the relay's `format: pane-attachment-id` schema vocab
   * validates the id) or in `pane create --input-data`.
   *
   * Scope defaults to "agent" (reusable across the agent's panes). For
   * `scope: "pane"` pass `paneId`; for `scope: "template"` pass
   * `templateId`. The agent must own the referenced pane / template;
   * cross-tenant attempts return attachment_not_found.
   *
   * MIME is inferred from `mime` if supplied; otherwise the relay sniffs
   * leading bytes and may reject with mime_mismatch / mime_disallowed.
   *
   * Backed by the relay's multipart `POST /v1/attachments` (the fallback path).
   * For large uploads (>1 MB on hosted Azure) call `presignBlob()` +
   * `confirmBlob()` instead — those use SAS direct-to-storage and don't
   * stream bytes through the relay.
   */
  async uploadBlob(
    file: Blob | Buffer | Uint8Array,
    opts: UploadBlobOptions = {},
  ): Promise<AttachmentRef> {
    const fd = new FormData();
    let attachment: Blob;
    if (file instanceof Blob) {
      attachment = file;
    } else {
      // Buffer / Uint8Array path — wrap in a Blob with the declared MIME.
      // Copy into a freshly allocated Uint8Array so the buffer type
      // narrows from `ArrayBufferLike` (which includes SharedArrayBuffer)
      // to `ArrayBuffer` specifically — the Blob constructor accepts only
      // the latter under @types/node ≥25 + TS ≥5.7's generic narrowing of
      // Uint8Array<TArrayBuffer>. `new Uint8Array(length)` returns
      // `Uint8Array<ArrayBuffer>` by construction, satisfying AttachmentPart
      // without a type cast. The extra copy is one walk over the bytes —
      // negligible vs the network upload that follows.
      const src = file instanceof Uint8Array ? file : new Uint8Array(file);
      const u8 = new Uint8Array(src.byteLength);
      u8.set(src);
      attachment = new Blob([u8], {
        type: opts.mime ?? "application/octet-stream",
      });
    }
    fd.set("file", attachment, opts.filename ?? "attachment");
    if (opts.scope) fd.set("scope", opts.scope);
    if (opts.paneId) fd.set("pane_id", opts.paneId);
    if (opts.templateId) fd.set("template_id", opts.templateId);
    if (opts.filename) fd.set("filename", opts.filename);

    const url = this.base + "/v1/attachments";
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.apiKey,
          ...(this.cliVersion ? { "x-pane-cli-version": this.cliVersion } : {}),
        },
        body: fd,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PaneApiError(0, "fetch_error", msg);
    }
    const text = await res.text().catch(() => "");
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new PaneApiError(
        res.status,
        "non_json_response",
        `relay returned a non-JSON body (status ${res.status})`,
      );
    }
    if (!res.ok) {
      this.fail({ ok: false, status: res.status, data });
    }
    return data as AttachmentRef;
  }

  /** GET /v1/attachments/:id — download bytes as an ArrayBuffer. */
  async downloadBlob(attachmentId: string): Promise<ArrayBuffer> {
    const url =
      this.base + "/v1/attachments/" + encodeURIComponent(attachmentId);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: "Bearer " + this.apiKey,
        ...(this.cliVersion ? { "x-pane-cli-version": this.cliVersion } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      this.fail({ ok: false, status: res.status, data });
    }
    return res.arrayBuffer();
  }

  /**
   * GET a attachment's metadata only — useful before downloading large attachments, or
   * for `pane attachment show <id>` which doesn't want the bytes. Returns the full
   * AttachmentRef (the same shape POST /v1/attachments returns): id, scope, mime, size,
   * sha256, filename, width, height, status, scope FKs, timestamps.
   *
   * Backed by GET /v1/attachments/:id/metadata which serves the JSON AttachmentRef
   * without streaming the bytes — cheap on the relay and avoids the
   * encrypt-at-rest decrypt cost when only the metadata is needed.
   */
  async getBlob(attachmentId: string): Promise<AttachmentRef> {
    const r = await this.call(
      "GET",
      "/v1/attachments/" + encodeURIComponent(attachmentId) + "/metadata",
    );
    if (!r.ok) this.fail(r);
    return this.asObject<AttachmentRef>(r);
  }

  /** DELETE /v1/attachments/:id — soft-delete (idempotent). */
  async deleteBlob(attachmentId: string): Promise<{ deleted: true }> {
    const r = await this.call(
      "DELETE",
      "/v1/attachments/" + encodeURIComponent(attachmentId),
    );
    if (!r.ok) this.fail(r);
    return { deleted: true };
  }

  /**
   * Mint a `/b/<token>` capability URL for `attachmentId`. Default TTL is set by
   * the relay (24h agent, pane-TTL pane, 30d template). `once: true`
   * tokens self-delete on first GET.
   */
  async mintBlobToken(
    attachmentId: string,
    opts: { ttlSeconds?: number; once?: boolean } = {},
  ): Promise<AttachmentTokenMintResponse> {
    const r = await this.call(
      "POST",
      "/v1/attachments/" + encodeURIComponent(attachmentId) + "/tokens",
      { ttl_seconds: opts.ttlSeconds, once: opts.once },
    );
    if (!r.ok) this.fail(r);
    return r.data as AttachmentTokenMintResponse;
  }

  /** Revoke a previously-minted token. Idempotent. */
  async revokeBlobToken(
    attachmentId: string,
    tokenId: string,
  ): Promise<{ token_id: string; revoked: true }> {
    const r = await this.call(
      "DELETE",
      "/v1/attachments/" +
        encodeURIComponent(attachmentId) +
        "/tokens/" +
        encodeURIComponent(tokenId),
    );
    if (!r.ok) this.fail(r);
    return r.data as { token_id: string; revoked: true };
  }

  /**
   * GET /v1/attachments — list YOUR agent's non-deleted attachments (newest first).
   * Paginated via opaque cursor: when `next_cursor` is non-null, pass it
   * back as `cursor` on the next call.
   */
  async listBlobs(
    opts: ListBlobsOptions = {},
  ): Promise<{ items: AttachmentRef[]; next_cursor: string | null }> {
    const params = new URLSearchParams();
    if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const r = await this.call("GET", "/v1/attachments" + (qs ? "?" + qs : ""));
    if (!r.ok) this.fail(r);
    return r.data as { items: AttachmentRef[]; next_cursor: string | null };
  }

  /**
   * GET /v1/attachments/:id/tokens — enumerate the capability tokens minted
   * against one attachment, including revoked rows (for audit). The plaintext
   * token is NEVER returned — it isn't stored, only its sha256 is.
   */
  async listBlobTokens(
    attachmentId: string,
  ): Promise<AttachmentTokenListResponse> {
    const r = await this.call(
      "GET",
      "/v1/attachments/" + encodeURIComponent(attachmentId) + "/tokens",
    );
    if (!r.ok) this.fail(r);
    return r.data as AttachmentTokenListResponse;
  }

  /**
   * Issue a presigned PUT URL for direct-to-storage upload. Returns the
   * upload URL + the attachment_id (already reserved in the relay's DB with
   * status=pending) + expiry. After PUTting the bytes to the URL, call
   * `confirmBlob(attachment_id)` to finalise.
   *
   * Filesystem backend returns 501 not_implemented — use uploadBlob()
   * (multipart fallback) instead. Azure backend returns a SAS URL.
   */
  async presignBlob(opts: PresignBlobOptions): Promise<{
    attachment_id: string;
    upload_url: string;
    expires_at: string;
  }> {
    const r = await this.call("POST", "/v1/attachments/presign", {
      mime: opts.mime,
      size: opts.size,
      sha256: opts.sha256,
      scope: opts.scope,
      pane_id: opts.paneId,
      template_id: opts.templateId,
      filename: opts.filename,
    });
    if (!r.ok) this.fail(r);
    return r.data as {
      attachment_id: string;
      upload_url: string;
      expires_at: string;
    };
  }

  /** Finalise a presigned upload — relay HEADs the bytes, verifies, flips ready. */
  async confirmBlob(attachmentId: string): Promise<AttachmentRef> {
    const r = await this.call(
      "POST",
      "/v1/attachments/" + encodeURIComponent(attachmentId) + "/confirm",
    );
    if (!r.ok) this.fail(r);
    return r.data as AttachmentRef;
  }
}

/** Per-attachment metadata as returned by `POST /v1/attachments` and friends. */
export interface AttachmentRef {
  attachment_id: string;
  scope: "agent" | "pane" | "template";
  mime: string;
  size: number;
  sha256: string;
  url?: string;
  width?: number | null;
  height?: number | null;
  filename?: string | null;
  status?: string;
  pane_id?: string | null;
  template_id?: string | null;
  created_at?: string;
  confirmed_at?: string | null;
  deleted_at?: string | null;
}

export interface UploadBlobOptions {
  scope?: "agent" | "pane" | "template";
  paneId?: string;
  templateId?: string;
  /** Declared Content-Type. Defaults to `application/octet-stream`. The
   *  relay sniffs leading bytes and may reject with `mime_mismatch`. */
  mime?: string;
  /** Optional display name (the relay records it for UX; never a path component). */
  filename?: string;
}

export interface PresignBlobOptions {
  mime: string;
  size: number;
  sha256: string;
  scope?: "agent" | "pane" | "template";
  paneId?: string;
  templateId?: string;
  filename?: string;
}

export interface AttachmentTokenMintResponse {
  token_id: string;
  token: string;
  token_prefix: string;
  url: string;
  expires_at: string;
  once: boolean;
}

/** Options for `listBlobs()` — opaque cursor + page-size knob. */
export interface ListBlobsOptions {
  /** Opaque pagination cursor from a prior `next_cursor`. */
  cursor?: string;
  /** Page size; relay clamps to 1..100. Defaults to the relay default (50). */
  limit?: number;
}

/** One row in the response from `listBlobTokens()`. */
export interface AttachmentTokenAuditEntry {
  token_id: string;
  token_prefix: string;
  expires_at: string;
  once: boolean;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  /** Non-null when the token has been revoked. Expired-but-unrevoked rows
   *  carry `revoked_at: null` and an `expires_at` in the past — both are
   *  useful for audit. */
  revoked_at: string | null;
}

/** Shape returned by `listBlobTokens()`. */
export interface AttachmentTokenListResponse {
  attachment_id: string;
  items: AttachmentTokenAuditEntry[];
}
