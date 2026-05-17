import { createHmac } from "node:crypto";
import type { SerializedEvent } from "../types.js";
import { log } from "../log.js";

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
  sessionId: string,
  event: SerializedEvent,
): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ session_id: sessionId, event });
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
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
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
