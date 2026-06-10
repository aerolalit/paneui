// Web Push notification sender.
//
// Disabled when VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — the relay
// boots and runs normally; push subscriptions are silently no-ops.
//
// Usage: call notifyHuman() after creating a pane for a human owner. The
// function fans the notification out to all of the human's stored push
// subscriptions and prunes stale ones (HTTP 410 Gone) automatically.

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

export async function notifyHuman(
  prisma: PrismaClient,
  config: Config,
  humanId: string,
  payload: PushPayload,
): Promise<void> {
  if (!isPushEnabled(config)) return;

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
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
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
