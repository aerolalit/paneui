// Shared pane-serving logic — the single rendering path behind every way of
// opening a pane in a browser:
//
//   /s/:token            capability-token mount (src/bridge/routes.ts)
//   /panes/:id           owner-shell mount       (src/http/routes/owner-shell.ts)
//   /p/:paneId           identity-share mount    (src/http/routes/pane-access.ts)
//
// All three differ ONLY in how the caller is authorised + which callback URLs
// the shell points at. The actual HTML (shell chrome + iframe content) and the
// security headers are produced here so the three mounts can never drift on
// what the page is allowed to do.
//
// `recordView` is the Recents hook: every authenticated open by a logged-in
// human upserts a HumanPaneView row and bumps lastViewedAt. Anonymous opens
// record nothing.

import type { Context } from "hono";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import {
  computeAgentPresence,
  renderShell,
  RUNTIME_JS,
  PERMISSIONS_POLICY,
} from "./routes.js";
import { PANE_DEFAULT_CSS, shouldInjectDefaults } from "./default-styles.js";
import type { EventSchema } from "../types.js";

// The minimal pane shape the serving helpers need. Mirrors what every mount
// already loads (the pane row + its pinned template version).
export interface ServeablePane {
  id: string;
  agentId: string;
  status: string;
  expiresAt: Date;
  title: string;
  preamble: string | null;
  inputData: unknown;
  templateVersion: {
    eventSchema: unknown;
    templateType: string;
    templateSource: string;
  };
}

function publicWsBase(config: Config): string {
  const u = new URL(config.publicUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/$/, "");
}

// How the caller reached this pane — drives the callback URLs baked into the
// shell config + the WS-ticket auth header. The three mounts each build one of
// these and hand it to servePaneShell; the HTML body is identical regardless.
export interface PaneServeMode {
  // URL segment the shell's sub-resources hang off, e.g. `/s/<token>`,
  // `/panes/<id>`, `/p/<id>`.
  basePath: string;
  // ws-ticket endpoint + the Authorization header value to send on the POST.
  // Token mode carries `Bearer <token>`; cookie modes pass null (the
  // pane_login cookie travels automatically).
  wsTicketUrl: string;
  wsTicketAuthorization: string | null;
  // Slim account bar shown for a logged-in human; null for anonymous callers.
  topNav: { email: string } | null;
  // Optional override for the apple-touch-icon href. Defaults to the static
  // `/apple-touch-icon.png` (the icon route is cookie/visibility-gated and iOS
  // may fetch the icon without the cookie).
  appleTouchIconHref?: string;
}

// Same security headers every shell page sets. Centralised so the three mounts
// can't drift. `connectWsBase` is allowed in connect-src so the shell can open
// its WebSocket; everything else stays under 'self'.
function setShellHeaders(c: Context, nonce: string, connectWsBase: string) {
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
      `connect-src 'self' ${connectWsBase}`,
      "frame-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Permissions-Policy", PERMISSIONS_POLICY);
  c.header("Cache-Control", "private, no-store");
  c.header("Content-Type", "text/html; charset=utf-8");
}

// Render the shell HTML for a pane. The body is byte-identical across mounts;
// only the `mode` (callback URLs + auth header + account bar) varies.
export async function servePaneShell(
  c: Context,
  prisma: PrismaClient,
  config: Config,
  pane: ServeablePane,
  mode: PaneServeMode,
): Promise<Response> {
  const { agentLive, agentLastEventAt, agentLastUsedAt } =
    await computeAgentPresence(prisma, pane);
  const isClosed =
    pane.status !== "open" || pane.expiresAt.getTime() < Date.now();

  const wsBase = publicWsBase(config);
  const wsUrl = wsBase + "/v1/panes/" + pane.id + "/stream";
  const schema = pane.templateVersion.eventSchema as unknown as EventSchema;

  const nonceBuf = new Uint8Array(16);
  crypto.getRandomValues(nonceBuf);
  const nonce = Buffer.from(nonceBuf).toString("base64url");

  setShellHeaders(c, nonce, wsBase);

  const seg = mode.basePath;
  return c.body(
    renderShell({
      nonce,
      paneId: pane.id,
      iframeContentUrl: `${seg}/content`,
      presenceUrl: `${seg}/presence`,
      wsTicketUrl: mode.wsTicketUrl,
      wsTicketAuthorization: mode.wsTicketAuthorization,
      attachmentsUploadUrl: `${seg}/attachments`,
      attachmentsDownloadUrlBase: `${seg}/attachments`,
      schema,
      inputData: pane.inputData ?? null,
      wsUrl,
      isClosed,
      agentLive,
      agentLastEventAt,
      agentLastUsedAt,
      title: pane.title,
      preamble: pane.preamble,
      topNav: mode.topNav,
      // The /p/:paneId pane-icon route would be cookie/visibility-gated, and
      // iOS may fetch the apple-touch-icon without the cookie — so point at the
      // static default, matching the owner-shell mount's reasoning.
      appleTouchIconHref: mode.appleTouchIconHref ?? "/apple-touch-icon.png",
    }),
  );
}

// Render the iframe template body (the `/content` sub-resource). Identical
// across mounts; the caller is responsible for the closed-pane gate before
// calling this (each mount surfaces the gone error in its own error shape).
export function renderPaneContent(c: Context, pane: ServeablePane): Response {
  let artifactBody: string;
  if (pane.templateVersion.templateType === "html-inline") {
    artifactBody = pane.templateVersion.templateSource;
  } else {
    // html-ref is rejected at POST /v1/panes — defence-in-depth for any
    // pre-existing row.
    artifactBody = "<!-- template.type=html-ref is not implemented in v1 -->";
  }

  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data: attachment:",
      "media-src attachment:",
      "font-src data:",
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Permissions-Policy", PERMISSIONS_POLICY);
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "private, no-store");

  const styleBlock = shouldInjectDefaults(artifactBody)
    ? `<style>${PANE_DEFAULT_CSS}</style>`
    : "";
  const wrapped = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${styleBlock}
<script>${RUNTIME_JS}</script>
</head>
<body>
${artifactBody}
</body>
</html>`;
  return c.body(wrapped);
}

export { recordView } from "./recents.js";
