import { createHmac } from "node:crypto";
import type { SerializedEvent } from "../types.js";
import { log } from "../log.js";
import { assertSafeWebhookUrl } from "./ssrf.js";

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

// Fire-and-forget. Returns a promise the caller may `.catch()` for hygiene
// but should not await on the request path.
export async function fire(
  cfg: WebhookConfig,
  paneId: string,
  event: SerializedEvent,
): Promise<void> {
  // F-14 — re-validate the callback URL at FIRE time, not just at pane-create
  // time. assertSafeWebhookUrl re-resolves DNS and rejects loopback / private /
  // link-local (incl. the 169.254.169.254 metadata IP) / CGNAT targets. The
  // create-time check (routes/panes.ts) can be defeated by DNS rebinding: an
  // attacker lets the host resolve to a public IP at create time, then rebinds
  // it to an internal address before the webhook fires. Re-resolving here at
  // send time drastically narrows that window. It does NOT fully close it —
  // there is still a TOCTOU gap between this lookup and the kernel's own
  // resolution inside fetch (the platform fetch does not expose a lookup hook
  // to pin the resolved IP, so we can't connect-to-pinned-IP without replacing
  // the HTTP stack). `redirect: "manual"` (below) already blocks redirect-
  // chaining to an internal address. Residual risk is documented in ssrf.ts;
  // egress network policy remains the defence-in-depth that fully closes it.
  try {
    await assertSafeWebhookUrl(cfg.url);
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

  // 1 attempt + 2 retries; backoff 0s, 1s, 3s.
  const delays = [0, 1000, 3000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]!));
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Pane-Timestamp": String(ts),
          "X-Pane-Signature": `sha256=${sig}`,
        },
        body,
        // redirect: "manual" — do NOT follow 3xx. The webhook URL is SSRF-
        // validated only at pane-create time; following a redirect would
        // let a validated public target 302 the relay to an internal address
        // (e.g. the cloud metadata service at 169.254.169.254), bypassing the
        // guard. A redirect is treated as a failed delivery, not chased.
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (
        res.type === "opaqueredirect" ||
        (res.status >= 300 && res.status < 400)
      ) {
        log.warn("webhook redirect rejected", {
          url: cfg.url,
          status: res.status,
          attempt: i + 1,
        });
        continue;
      }
      if (res.ok) return;
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
