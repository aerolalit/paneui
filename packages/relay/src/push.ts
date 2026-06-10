// Web Push notification sender.
//
// Disabled when VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — the relay
// boots and runs normally; push subscriptions are silently no-ops.
//
// Usage: call notifyHuman() after creating a pane for a human owner. The
// function fans the notification out to all of the human's stored push
// subscriptions and prunes stale ones (HTTP 410 Gone) automatically.
//
// Coalescing: a busy agent can create many panes in quick succession. To avoid
// spamming the human with a buzz per pane, notifyHuman() throttles per human
// using a leading-edge + trailing-aggregate window (PUSH_COALESCE_WINDOW_
// SECONDS): the FIRST notification fires immediately (good UX — the human sees
// the pane right away), and any further notifications inside the window are
// buffered and delivered as a single "N new panes" message when the window
// closes. While the human keeps receiving panes the window re-arms, so they get
// at most one notification per window. Set the window to 0 to disable
// coalescing and send every notification immediately.

import webpush from "web-push";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import { log } from "./log.js";

export interface PushPayload {
  title: string;
  body?: string;
  paneUrl: string;
}

export function isPushEnabled(config: Config): boolean {
  return !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
}

// Fan a single payload out to every push subscription the human has, pruning
// any that the push service reports as expired/gone (410/404). This is the
// actual network send — notifyHuman() wraps it with per-human coalescing.
async function deliver(
  prisma: PrismaClient,
  config: Config,
  humanId: string,
  payload: PushPayload,
): Promise<void> {
  webpush.setVapidDetails(
    config.VAPID_MAILTO,
    config.VAPID_PUBLIC_KEY!,
    config.VAPID_PRIVATE_KEY!,
  );

  const subs = await prisma.pushSubscription.findMany({
    where: { humanId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });

  if (subs.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
        );
      } catch (err) {
        const status = (err as { statusCode?: number } | null)?.statusCode;
        if (status === 410 || status === 404) {
          // Subscription is expired or gone — delete it.
          await prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => {
              /* already deleted, ignore */
            });
        } else {
          log.warn("push notification delivery failed", {
            humanId,
            endpoint: sub.endpoint.slice(0, 40) + "…",
            status,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }),
  );
}

// Collapse several pane-created payloads into a single summary notification.
// Lists the first few titles, deep-links to the most recent pane in the batch.
// Exported for unit testing.
export function aggregatePayloads(payloads: PushPayload[]): PushPayload {
  const n = payloads.length;
  const last = payloads[payloads.length - 1]!;
  const titles = payloads
    .map((p) => p.title)
    .filter((t): t is string => !!t && t.trim().length > 0);
  const shown = titles.slice(0, 3).join(", ");
  const more = titles.length > 3 ? `, +${titles.length - 3} more` : "";
  return {
    title: `${n} new panes`,
    body: shown ? shown + more : `${n} new panes created`,
    // Deep-link to the most recent pane in the batch — the one the human is
    // most likely to want open.
    paneUrl: last.paneUrl,
  };
}

export interface PushCoalescer {
  // Submit a notification for a human. Either sends immediately (leading edge,
  // no active window) or buffers it for the next aggregate flush.
  submit(humanId: string, payload: PushPayload): void;
}

interface CoalesceWindow {
  // Fires at the end of the current window to flush buffered payloads.
  timer: ReturnType<typeof setTimeout>;
  // Payloads received during the window, awaiting an aggregate flush. Empty
  // when the window is just the cooldown after a leading-edge send.
  buffered: PushPayload[];
}

// Leading-edge + trailing-aggregate throttle, per human. `send` is the actual
// delivery sink (the real deliver(), or a stub in tests). Pure of config /
// Prisma so it can be unit-tested with fake timers and a fake send.
export function createPushCoalescer(
  windowMs: number,
  send: (humanId: string, payload: PushPayload) => void | Promise<void>,
): PushCoalescer {
  const windows = new Map<string, CoalesceWindow>();

  function schedule(humanId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => flush(humanId), windowMs);
    // A pending coalesce flush must not keep the process alive on shutdown.
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function flush(humanId: string): void {
    const w = windows.get(humanId);
    if (!w) return;
    if (w.buffered.length === 0) {
      // Quiet window — nothing arrived after the leading edge. Close it; the
      // next submit becomes a fresh leading edge and sends immediately.
      windows.delete(humanId);
      return;
    }
    const batch = w.buffered;
    w.buffered = [];
    // Keep throttling while the human is still active: re-arm the window so a
    // continued burst coalesces too. A subsequent quiet window closes it.
    w.timer = schedule(humanId);
    const payload = batch.length === 1 ? batch[0]! : aggregatePayloads(batch);
    void send(humanId, payload);
  }

  return {
    submit(humanId, payload) {
      const w = windows.get(humanId);
      if (!w) {
        // Leading edge — deliver now and open a throttle window.
        windows.set(humanId, { timer: schedule(humanId), buffered: [] });
        void send(humanId, payload);
        return;
      }
      // Within an active window — buffer for the trailing aggregate flush.
      w.buffered.push(payload);
    },
  };
}

// Lazily-built singleton coalescer. The relay has one Config / PrismaClient for
// its lifetime, so building it once on first use is safe; the latest prisma /
// config are read at flush time via the refs below (they don't change in
// production — the indirection only matters across test invocations).
let coalescer: PushCoalescer | null = null;
let currentPrisma: PrismaClient | null = null;
let currentConfig: Config | null = null;

export async function notifyHuman(
  prisma: PrismaClient,
  config: Config,
  humanId: string,
  payload: PushPayload,
): Promise<void> {
  if (!isPushEnabled(config)) return;

  currentPrisma = prisma;
  currentConfig = config;

  const windowMs = config.PUSH_COALESCE_WINDOW_SECONDS * 1000;
  if (windowMs <= 0) {
    // Coalescing disabled — send every notification immediately.
    await deliver(prisma, config, humanId, payload);
    return;
  }

  if (!coalescer) {
    coalescer = createPushCoalescer(windowMs, (hId, p) =>
      deliver(currentPrisma!, currentConfig!, hId, p),
    );
  }
  coalescer.submit(humanId, payload);
}
