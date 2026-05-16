// Pane relay HTTP client. Pure: no argv, no process.env reads, no MCP.
// The caller supplies the relay base URL + API key explicitly.

import type {
  CreateSessionRequest,
  CreateSessionResponse,
  EventsPage,
  PaneEvent,
  SessionState,
} from "./types.js";

export interface ClientOptions {
  /** Relay base URL, e.g. https://pane.example.com. Trailing slash is trimmed. */
  url: string;
  /** Agent API key (bearer token). */
  apiKey: string;
  /** Optional fetch override (defaults to global fetch). */
  fetch?: typeof fetch;
}

/** Low-level relay response: ok flag, HTTP status, parsed JSON body. */
export interface RelayResponse {
  ok: boolean;
  status: number;
  data: unknown;
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

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PaneApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class PaneClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.base = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
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
  async call(method: string, path: string, body?: object): Promise<RelayResponse> {
    const url = this.base + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: "Bearer " + this.apiKey,
          ...(body ? { "content-type": "application/json" } : {}),
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
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    }
    return { ok: res.ok, status: res.status, data };
  }

  /** Throw a PaneApiError from a failed RelayResponse. */
  private fail(r: RelayResponse): never {
    const err = (r.data as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new PaneApiError(
      r.status,
      err?.code ?? "relay_error",
      err?.message ?? `relay returned ${r.status}`,
      err?.details,
    );
  }

  /** POST /v1/sessions — create a session. */
  async createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
    const r = await this.call("POST", "/v1/sessions", {
      artifact: req.artifact,
      schema: req.schema,
      participants: req.participants,
      ttl: req.ttl,
      metadata: req.metadata,
      callback: req.callback,
    });
    if (!r.ok) this.fail(r);
    return r.data as CreateSessionResponse;
  }

  /** GET /v1/sessions/:id — non-blocking session metadata. */
  async getSession(sessionId: string): Promise<SessionState> {
    const r = await this.call("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
    if (!r.ok) this.fail(r);
    return r.data as SessionState;
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
    return r.data as EventsPage;
  }

  /** POST /v1/sessions/:id/events — append an agent event. */
  async sendEvent(
    sessionId: string,
    ev: { type: string; data: unknown; causationId?: string; idempotencyKey?: string },
  ): Promise<{ event: PaneEvent; deduped: boolean }> {
    const r = await this.call("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      type: ev.type,
      data: ev.data,
      causation_id: ev.causationId,
      idempotency_key: ev.idempotencyKey,
    });
    if (!r.ok) this.fail(r);
    const body = r.data as { event: PaneEvent; deduped?: boolean };
    return { event: body.event, deduped: body.deduped ?? false };
  }
}
