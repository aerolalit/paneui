// Standalone agent self-registration: POST /v1/register.
//
// Unlike PaneClient operations this needs no bearer API key — registration is
// the call that *obtains* one. The relay endpoint is open: no secret. Abuse
// is bounded server-side by a per-IP rate limit (a 429 surfaces here as a
// PaneApiError with status 429).

import { PaneApiError } from "./client.js";

export interface RegisterAgentOptions {
  /** Relay base URL, e.g. https://pane.example.com. Trailing slash is trimmed. */
  url: string;
  /** Optional agent display name; the relay defaults it if omitted. */
  name?: string;
  /** Optional fetch override (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface RegisterAgentResult {
  agent_id: string;
  api_key: string;
  key_prefix: string;
}

/**
 * Provision a fresh agent + API key from the relay. Mirrors PaneClient.call's
 * never-throw-raw style: network/parse failures and non-2xx responses are
 * surfaced as PaneApiError.
 */
export async function registerAgent(
  opts: RegisterAgentOptions,
): Promise<RegisterAgentResult> {
  const base = opts.url.replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body["name"] = opts.name;

  let res: Response;
  try {
    res = await fetchImpl(base + "/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PaneApiError(0, "fetch_error", msg);
  }

  let data: unknown = null;
  const text = await res.text().catch(() => "");
  if (text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      const snippet = text.length > 500 ? text.slice(0, 500) + "…" : text;
      throw new PaneApiError(
        res.status,
        "non_json_response",
        `relay returned a non-JSON body (status ${res.status})`,
        { body: snippet },
      );
    }
  }

  if (!res.ok) {
    const err = (
      data as {
        error?: { code?: string; message?: string; details?: unknown };
      } | null
    )?.error;
    throw new PaneApiError(
      res.status,
      err?.code ?? "relay_error",
      err?.message ?? `relay returned ${res.status}`,
      err?.details,
    );
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new PaneApiError(
      res.status,
      "invalid_response",
      `relay returned a ${res.status} with a non-object body`,
      { body: data },
    );
  }
  return data as RegisterAgentResult;
}
