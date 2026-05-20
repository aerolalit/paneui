// Pane relay HTTP client. Pure: no argv, no process.env reads, no MCP.
// The caller supplies the relay base URL + API key explicitly.

import type {
  ArtifactRecord,
  ArtifactSummary,
  ArtifactType,
  ArtifactVersion,
  CreateArtifactResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  EventsPage,
  KeyInfo,
  PaneEvent,
  SessionState,
  TasteInfo,
} from "./types.js";
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
 * Request body for POST /v1/artifacts — create a named, reusable artifact plus
 * its v1 content. Mirrors `createArtifactSchema` from ./schemas.js.
 */
export interface CreateArtifactRequest {
  name: string;
  slug?: string;
  description?: string;
  tags?: string[];
  source: string;
  type: ArtifactType;
  event_schema?: unknown;
  input_schema?: Record<string, unknown>;
}

/**
 * Request body for POST /v1/artifacts/:id/versions — append a new immutable
 * version (content only). Mirrors `createArtifactVersionSchema`.
 */
export interface CreateArtifactVersionRequest {
  source: string;
  type: ArtifactType;
  event_schema?: unknown;
  input_schema?: Record<string, unknown>;
}

/**
 * Request body for PATCH /v1/artifacts/:id — head metadata only (never
 * content). Mirrors `patchArtifactMetadataSchema`.
 */
export interface PatchArtifactMetadataRequest {
  name?: string;
  slug?: string;
  description?: string;
  tags?: string[];
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
          // Don't discard it — surface the raw text so callers can diagnose.
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

  /** POST /v1/sessions — create a session. */
  async createSession(
    req: CreateSessionRequest,
  ): Promise<CreateSessionResponse> {
    const r = await this.call("POST", "/v1/sessions", {
      artifact: req.artifact,
      input_data: req.input_data,
      participants: req.participants,
      ttl: req.ttl,
      metadata: req.metadata,
      callback: req.callback,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<CreateSessionResponse>(r);
  }

  /** GET /v1/sessions/:id — non-blocking session metadata. */
  async getSession(sessionId: string): Promise<SessionState> {
    const r = await this.call(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<SessionState>(r);
  }

  /**
   * GET /v1/sessions/:id/events — fetch the event log.
   * `since` is an opaque cursor; `waitSeconds` enables the relay long-poll
   * (0 = non-blocking, capped at 30 by the relay).
   */
  async getEvents(
    sessionId: string,
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
      `/v1/sessions/${encodeURIComponent(sessionId)}/events${qs ? "?" + qs : ""}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<EventsPage>(r);
  }

  /** POST /v1/sessions/:id/events — append an agent event. */
  async sendEvent(
    sessionId: string,
    ev: {
      type: string;
      data: unknown;
      causationId?: string;
      idempotencyKey?: string;
    },
  ): Promise<{ event: PaneEvent; deduped: boolean }> {
    const r = await this.call(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
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
   * POST /v1/artifacts — create a named, reusable artifact and its v1 content.
   * Returns the new `artifact_id` and `version` (1).
   */
  async createArtifact(
    req: CreateArtifactRequest,
  ): Promise<CreateArtifactResponse> {
    const r = await this.call("POST", "/v1/artifacts", {
      name: req.name,
      slug: req.slug,
      description: req.description,
      tags: req.tags,
      source: req.source,
      type: req.type,
      event_schema: req.event_schema,
      input_schema: req.input_schema,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<CreateArtifactResponse>(r);
  }

  /**
   * POST /v1/artifacts/:id/versions — append a new immutable version to an
   * existing artifact. `idOrSlug` accepts the artifact id or its slug.
   * Returns the new `version` number.
   */
  async createArtifactVersion(
    idOrSlug: string,
    req: CreateArtifactVersionRequest,
  ): Promise<CreateArtifactResponse> {
    const r = await this.call(
      "POST",
      `/v1/artifacts/${encodeURIComponent(idOrSlug)}/versions`,
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
   * PATCH /v1/artifacts/:id — update head metadata (name / slug / description /
   * tags); never the content. Returns the updated lean summary.
   */
  async updateArtifact(
    idOrSlug: string,
    metadata: PatchArtifactMetadataRequest,
  ): Promise<ArtifactSummary> {
    const r = await this.call(
      "PATCH",
      `/v1/artifacts/${encodeURIComponent(idOrSlug)}`,
      {
        name: metadata.name,
        slug: metadata.slug,
        description: metadata.description,
        tags: metadata.tags,
      },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<ArtifactSummary>(r);
  }

  /**
   * GET /v1/artifacts?q=... — search/list the agent's named artifacts. The
   * response is lean (no `source` blob), ranked by `last_used_at`. Omit `query`
   * to list every named artifact.
   */
  async searchArtifacts(query?: string): Promise<ArtifactSummary[]> {
    const qs =
      query != null && query !== "" ? "?q=" + encodeURIComponent(query) : "";
    const r = await this.call("GET", `/v1/artifacts${qs}`);
    if (!r.ok) this.fail(r);
    return this.asObject<{ artifacts: ArtifactSummary[] }>(r).artifacts;
  }

  /**
   * GET /v1/artifacts/:id — fetch a full artifact (head metadata + version
   * list). `idOrSlug` accepts the artifact id or its slug.
   */
  async getArtifact(idOrSlug: string): Promise<ArtifactRecord> {
    const r = await this.call(
      "GET",
      `/v1/artifacts/${encodeURIComponent(idOrSlug)}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<ArtifactRecord>(r);
  }

  /**
   * GET /v1/artifacts/:id/versions/:version — fetch one version's full
   * content (HTML, event schema, input schema).
   */
  async getArtifactVersion(
    idOrSlug: string,
    version: number,
  ): Promise<ArtifactVersion> {
    const r = await this.call(
      "GET",
      `/v1/artifacts/${encodeURIComponent(idOrSlug)}/versions/${encodeURIComponent(String(version))}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<ArtifactVersion>(r);
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
   * GET /v1/taste — the calling agent's freeform "taste notes" markdown blob:
   * presentation preferences the agent has picked up from human feedback over
   * time. Returns `{ taste: null, updated_at: null, bytes: 0 }` when the
   * agent has never written notes. Read this before generating an artifact so
   * the agent applies prior feedback.
   */
  async getTaste(): Promise<TasteInfo> {
    const r = await this.call("GET", "/v1/taste");
    if (!r.ok) this.fail(r);
    return this.asObject<TasteInfo>(r);
  }

  /**
   * PUT /v1/taste — whole-blob replace of the calling agent's taste notes.
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
   * DELETE /v1/sessions/:id — close/delete a session. Idempotent on the relay
   * side (an already-closed session still returns 204 with no body).
   */
  async deleteSession(id: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(id)}`,
    );
    if (!r.ok) this.fail(r);
  }

  /**
   * DELETE /v1/artifacts/:id — remove an artifact and (server-side) all its
   * versions. Strict cascade: the relay refuses with 409 conflict if any
   * session in any state still references one of the artifact's versions —
   * surface that as a typed PaneApiError so the CLI can render a hint
   * instead of swallowing it.
   */
  async deleteArtifact(idOrSlug: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/artifacts/${encodeURIComponent(idOrSlug)}`,
    );
    if (!r.ok) this.fail(r);
  }
}
