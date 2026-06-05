import { createHmac } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { SerializedEvent } from "../types.js";
import { log } from "../log.js";
import { resolveSafeWebhookUrl, type ResolvedSafeHost } from "./ssrf.js";

export interface WebhookConfig {
  url: string;
  secret: string;
}

// Per-attempt request timeout. A non-responsive target must not hang the
// retry loop indefinitely; each attempt is aborted after this many ms.
export const WEBHOOK_TIMEOUT_MS = 10_000;

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globMatch(s: string, pattern: string): boolean {
  if (!pattern.includes("*")) return s === pattern;
  const rx = new RegExp(
    "^" + pattern.split("*").map(escapeRx).join(".*") + "$",
  );
  return rx.test(s);
}

function matchesFilter(type: string, filter: string[]): boolean {
  return filter.some((p) => globMatch(type, p));
}

export function shouldFire(
  type: string,
  filter: string[] | null | undefined,
): boolean {
  if (!filter || filter.length === 0) return false;
  return matchesFilter(type, filter);
}

// Outcome of a single pinned send attempt. We deliberately do NOT surface the
// response body — webhook delivery is blind, the relay must not echo target
// responses back into the system (would be an SSRF read primitive).
export interface SendOutcome {
  status: number;
  /** A 3xx the relay refuses to follow (manual-redirect semantics). */
  redirected: boolean;
}

/**
 * Perform ONE webhook POST, pinned to a pre-validated IP.
 *
 * The connection dials `pinned.address` (already verified safe by the SSRF
 * guard) rather than re-resolving `pinned.host`, closing the DNS-rebinding
 * TOCTOU: there is no second, unchecked resolution between the safety check and
 * the socket connect. To keep the request semantically identical to one made
 * against the hostname we:
 *   - override the DNS `lookup` so the socket connects to the pinned IP,
 *   - send the original `Host` header (so virtual hosts / routing still work),
 *   - set TLS `servername` (SNI) to the original hostname (so https
 *     certificate validation succeeds against the IP).
 *
 * Redirects are NOT followed (manual-redirect semantics preserved): a 3xx is
 * reported via `redirected` and treated by the caller as a failed delivery —
 * following it is the other SSRF vector (302 → internal address).
 *
 * Exported for tests, which mock it to assert pin/headers/redirect behaviour
 * without opening a real socket.
 */
export function sendOnce(
  pinned: ResolvedSafeHost,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<SendOutcome> {
  const { url, host, address, family } = pinned;
  const isHttps = url.protocol === "https:";
  const request = isHttps ? httpsRequest : httpRequest;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  return new Promise<SendOutcome>((resolve, reject) => {
    const req = request(
      {
        // Connect to the PINNED IP, never re-resolving the hostname. The custom
        // lookup is what guarantees the socket lands on the address we checked.
        host: address,
        // `lookup` returns the pinned IP for any name the stack would resolve;
        // since `host` is already an IP literal here it is effectively a no-op,
        // but we set it defensively in case the runtime attempts a resolution.
        lookup: (_hostname, _options, cb) => {
          // node:dns lookup callback shape: (err, address, family)
          (cb as (err: null, address: string, family: number) => void)(
            null,
            address,
            family,
          );
        },
        port,
        method: "POST",
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          // Preserve the original Host so the target routes correctly even
          // though we dialled an IP.
          host: url.host,
        },
        // TLS SNI + cert validation must use the real hostname, not the IP.
        ...(isHttps ? { servername: host } : {}),
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const redirected = status >= 300 && status < 400;
        // Drain and discard the body — blind delivery, nothing is returned to
        // the caller. Resolve once the response is consumed.
        res.resume();
        res.on("end", () => resolve({ status, redirected }));
        res.on("error", reject);
      },
    );

    req.on("timeout", () => {
      // Mirror fetch's AbortSignal.timeout: abort the in-flight request. The
      // resulting socket error surfaces via the 'error' handler below.
      req.destroy(new WebhookTimeoutError(timeoutMs));
    });
    req.on("error", reject);
    req.end(body);
  });
}

class WebhookTimeoutError extends Error {
  override name = "TimeoutError";
  constructor(timeoutMs: number) {
    super(`webhook request timed out after ${timeoutMs}ms`);
  }
}

// Indirection seam so `fire` calls the transport through a mutable reference
// rather than the lexical binding — lets tests swap `sendOnce` for a stub
// (intra-module ESM spies on the lexical binding are not reliably intercepted).
export const _internals = { sendOnce };

// Fire-and-forget. Returns a promise the caller may `.catch()` for hygiene
// but should not await on the request path.
export async function fire(
  cfg: WebhookConfig,
  paneId: string,
  event: SerializedEvent,
): Promise<void> {
  // F-14 follow-up — pin-and-connect. Resolve the callback host ONCE here at
  // fire time, verify every resolved address against the SSRF guard, and obtain
  // the single safe IP to dial. The send below connects to that pinned IP
  // instead of re-resolving the hostname, so there is no second, unchecked DNS
  // resolution for an attacker to rebind into (the residual TOCTOU the prior
  // assertSafeWebhookUrl-then-fetch approach left open, since fetch/undici
  // re-resolved DNS independently of the check). resolveSafeWebhookUrl rejects
  // loopback / private / link-local (incl. 169.254.169.254) / CGNAT targets and
  // any host that resolves to a mix including a blocked address.
  let pinned: ResolvedSafeHost;
  try {
    pinned = await resolveSafeWebhookUrl(cfg.url);
  } catch (err) {
    log.warn("webhook send aborted: url failed fire-time SSRF re-validation", {
      paneId,
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ pane_id: paneId, event });
  const sig = createHmac("sha256", cfg.secret)
    .update(`${ts}.${body}`)
    .digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Pane-Timestamp": String(ts),
    "X-Pane-Signature": `sha256=${sig}`,
  };

  // 1 attempt + 2 retries; backoff 0s, 1s, 3s.
  const delays = [0, 1000, 3000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]!));
    try {
      const res = await _internals.sendOnce(
        pinned,
        headers,
        body,
        WEBHOOK_TIMEOUT_MS,
      );
      if (res.redirected) {
        // redirect NOT followed — do NOT chase a 3xx. A validated public target
        // could 302 the relay to an internal address (e.g. the cloud metadata
        // service at 169.254.169.254), bypassing the guard. Treated as a failed
        // delivery, retried, never followed.
        log.warn("webhook redirect rejected", {
          url: cfg.url,
          status: res.status,
          attempt: i + 1,
        });
        continue;
      }
      if (res.status >= 200 && res.status < 300) return;
      log.warn("webhook non-2xx", {
        url: cfg.url,
        status: res.status,
        attempt: i + 1,
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        log.warn("webhook timeout", {
          url: cfg.url,
          timeoutMs: WEBHOOK_TIMEOUT_MS,
          attempt: i + 1,
        });
      } else {
        log.warn("webhook error", {
          url: cfg.url,
          error: e instanceof Error ? e.message : String(e),
          attempt: i + 1,
        });
      }
    }
  }
}
