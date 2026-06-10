// Service worker for Web Push notifications.
//
// Receives push messages from the relay's push.ts sender and either:
//   - Shows a native OS notification (app closed / not focused), or
//   - Forwards a message to the open window for an in-app toast (app focused).
//
// Compiled by tsc -p tsconfig.client.json into dist/client/sw.client.js and
// served at /sw.js by a dedicated route in app.ts. The script is NOT inlined
// via loadClient() — it is fetched by navigator.serviceWorker.register('/sw.js')
// and evaluated in the service worker scope, not the page scope.

export {};

// Runs in the service-worker scope, not a DOM window. We cast through unknown
// so TypeScript doesn't reject the event listener signatures — the runtime
// shapes are correct for a service worker even though the DOM lib types self
// as `Window`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sw = self as unknown as any;

sw.addEventListener("push", (event: { data?: { json(): unknown }; waitUntil(p: Promise<unknown>): void }) => {
  let data: { title?: string; body?: string; paneUrl?: string } = {};
  try {
    data = (event.data?.json() as typeof data) ?? {};
  } catch {
    /* malformed payload — use defaults */
  }

  const title = data.title ?? "New pane";
  const body = data.body;
  const paneUrl = data.paneUrl ?? "/home";

  event.waitUntil(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    sw.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients: Array<{ focused: boolean; postMessage(m: unknown): void }>) => {
        const focused = clients.find((c) => c.focused);
        if (focused) {
          // App is in the foreground — send a postMessage so the page can
          // show a subtle in-app toast instead of a full OS notification.
          focused.postMessage({ type: "pane.created", title, body, paneUrl });
          return;
        }
        // App is closed or in the background — show a native notification.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        return sw.registration.showNotification(title, {
          body,
          icon: "/apple-touch-icon.png",
          badge: "/icon-192.png",
          data: { paneUrl },
        });
      }),
  );
});

sw.addEventListener("notificationclick", (event: { notification: { close(): void; data: unknown }; waitUntil(p: Promise<unknown>): void }) => {
  event.notification.close();
  const url: string =
    (event.notification.data as { paneUrl?: string } | null)?.paneUrl ?? "/home";
  event.waitUntil(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    sw.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients: Array<{ focus(): void }>) => {
        // Bring an existing window into focus rather than opening a new tab.
        for (const client of clients) {
          if ("focus" in client) {
            void client.focus();
            return;
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        return sw.clients.openWindow(url);
      }),
  );
});
