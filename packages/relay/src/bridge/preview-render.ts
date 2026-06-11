// Artifact preview rendering — a standalone, non-interactive thumbnail of an
// artifact for the owner-shell home cards.
//
// Unlike `/content` (the live viewer body), a preview document is loaded by a
// sandboxed iframe with NO parent shell: there's no postMessage broker, no
// WebSocket, no `init` frame. So the live runtime's `window.pane` — which only
// resolves `inputData` after the shell sends `init` — would render every
// script-built artifact blank. Instead we embed `inputData` directly and ship a
// MINIMAL inert `window.pane` shim, defined BEFORE the artifact runs, so an
// inline script can read `pane.inputData` and call `pane.on/emit/state` without
// throwing or reaching the network.
//
// Trust boundary
// --------------
// The artifact HTML and `inputData` are agent-authored and UNTRUSTED — treated
// with the same sandbox + CSP posture as the live viewer (see buildPaneCsp, and
// the iframe `sandbox="allow-scripts"` the shell sets). `inputData` is embedded
// inside an inline `<script>` as JSON with the markup-significant characters
// escaped, so a value containing `</script>` or `<!--` can't break out of the
// tag and inject DOM.

import { PANE_DEFAULT_CSS, shouldInjectDefaults } from "./default-styles.js";

// Preview-thumbnail render geometry — shared by the preview document (this
// file), the owner-shell CSS (.tile-preview sizing) and the owner-shell JS
// (per-card scale). KEEP THESE THREE IN SYNC via these constants.
//
// A thumbnail must show the pane's full DESKTOP layout, but rendering it into a
// 1000px-wide iframe and shrinking with a CSS transform is what blew iOS
// WebKit's per-page graphics limit on high-DPR devices (iPhone 14 Pro Max): an
// iframe rasterises at its OWN css size × devicePixelRatio, so a 1000px frame is
// ~25-36MB of GPU memory EACH regardless of how light the pane is, and a gallery
// of them crashes the tab.
//
// Fix: render into a small PREVIEW_FRAME_PX-wide iframe but apply `zoom` in the
// document so its LAYOUT viewport is still 1000px (full desktop view), just
// rasterised low-res. `zoom = frame/1000` makes a PREVIEW_FRAME_PX-wide frame
// lay out at 1000px; the card then transform-scales the frame by
// display/PREVIEW_FRAME_PX. Backing store drops ~(1000/PREVIEW_FRAME_PX)² ≈ 11×.
export const PREVIEW_LOGICAL_WIDTH = 1000;
export const PREVIEW_FRAME_PX = 300;
export const PREVIEW_ZOOM = PREVIEW_FRAME_PX / PREVIEW_LOGICAL_WIDTH; // 0.3

// The single Content-Security-Policy both the live viewer's `/content` route
// and the preview endpoints set — built here so the two can never drift on
// policy. `imgMediaOrigin` is the relay's own public origin (scheme + host +
// optional port, e.g. `https://relay.paneui.com`); it is added to `img-src`
// and `media-src` so a template can render attachment bytes directly from a
// capability URL (`<img src="https://relay.../b/<token>">`) without the
// postMessage/Blob round-trip. This does NOT widen what the iframe can obtain:
//   - the iframe is sandboxed WITHOUT `allow-same-origin`, so it has an opaque
//     origin and carries no `pane_login` cookie — only the capability token in
//     the URL path authorises the fetch, and `/b/:token` already gatekeeps it
//     (entropy + revoke + TTL + status checks);
//   - `connect-src 'none'` stays, so `fetch`/XHR/WebSocket remain blocked —
//     only `<img>`/`<video>`/`<audio>` *display* loads are enabled.
// `data:` is retained for small inline bytes. The `attachment:` scheme is NOT
// in the allowlist: it has no handler (a custom scheme can't be intercepted by
// a service worker, and the opaque-origin iframe can't register one anyway), so
// listing it only advertised a path that silently failed. Returned as the
// joined header value.
export function buildPaneCsp(imgMediaOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: ${imgMediaOrigin}`,
    `media-src ${imgMediaOrigin}`,
    "font-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

// Extract the CSP source-origin (scheme + host + optional port) from the
// relay's configured public URL. `config.publicUrl` is always set (defaults to
// `http://localhost:<PORT>`) and validated as a URL, so `new URL(...)` is safe.
// `'self'` cannot be used in its place: the sandboxed iframe has an opaque
// origin that never matches `'self'`, so the origin must be named explicitly.
export function paneCspImgOrigin(publicUrl: string): string {
  return new URL(publicUrl).origin;
}

// Embed an arbitrary value as a JS literal inside an inline `<script>`. We
// serialize to JSON, then neutralise the only sequences an HTML parser treats
// as significant inside a `<script>` element:
//   `<` → `<`  defuses `</script>` (tag close) and `<!--` (comment start)
//   `/` after `<` is already covered by escaping `<`, but we also escape line
//       and paragraph separators which are valid JSON yet illegal in JS string
//       literals (would otherwise be a SyntaxError).
// `undefined` (e.g. a pane with no input_data) collapses to `null`.
function embedJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// The inert `window.pane` shim. Just enough surface that an artifact's inline
// script can read inputData and register/emit without throwing:
//   - inputData: the embedded value
//   - ready: resolved (no init frame is coming)
//   - on(): no-op, returns an unsubscribe no-op
//   - emit(): resolves to a stub ack, never hits the network
//   - state: empty event log with last()/subscribe() stubs
//   - records / template.records: empty snapshot() + no-op on() (+ write stubs
//     that resolve inertly) — a records-backed page (todo list, kanban, …) must
//     not throw `Cannot read properties of undefined (reading 'snapshot'/'on')`
//     in a thumbnail. The live runtime exposes these (runtime.client.ts); the
//     preview MUST mirror the surface or every records page renders blank with
//     an uncaught TypeError.
//   - uploadBlob/downloadBlob/saveBlob: reject — a thumbnail can't broker blobs
// `__PANE_INPUT__` is the embedded-JSON placeholder filled by the caller.
function paneShim(inputDataLiteral: string): string {
  return `(function(){
  var inputData = ${inputDataLiteral};
  var noop = function(){};
  var unsub = function(){ return noop; };
  var emptySnapshot = function(){ return []; };
  var resolveNull = function(){ return Promise.resolve(null); };
  var pane = {
    inputData: inputData,
    ready: Promise.resolve(),
    on: unsub,
    emit: function(){ return Promise.resolve({ id: "", deduped: false }); },
    state: {
      events: [],
      last: function(){ return null; },
      subscribe: function(){ return noop; }
    },
    // Pane-level records (mutable collections). Reads return empty, writes
    // resolve inertly, subscriptions are no-ops — a frozen snapshot has no
    // live store and a thumbnail can't mutate one.
    records: {
      snapshot: emptySnapshot,
      on: unsub,
      create: resolveNull,
      upsert: resolveNull,
      update: resolveNull,
      delete: function(){ return Promise.resolve(); }
    },
    // Template-level records — read-only mirror in the live runtime; inert here.
    template: {
      records: {
        snapshot: emptySnapshot,
        on: unsub
      }
    },
    uploadBlob: function(){ return Promise.reject(new Error("preview: blobs unavailable")); },
    downloadBlob: function(){ return Promise.reject(new Error("preview: blobs unavailable")); },
    saveBlob: function(){ return Promise.reject(new Error("preview: blobs unavailable")); }
  };
  try {
    Object.freeze(pane.state);
    Object.freeze(pane.records);
    Object.freeze(pane.template.records);
    Object.freeze(pane.template);
    Object.freeze(pane);
  } catch (e) {}
  window.pane = pane;
})();`;
}

// Wrap an artifact body into a self-contained preview document.
//   - the default stylesheet (same as the viewer; skipped on `data-pane-bare`)
//   - the inert `window.pane` shim, BEFORE the artifact so its inline scripts
//     see a populated `window.pane`
//   - the artifact HTML in `<body>`
// No runtime bundle, no WebSocket, no postMessage — a frozen snapshot.
export function wrapArtifactForPreview(
  artifactBody: string,
  inputData: unknown,
): string {
  const styleBlock = shouldInjectDefaults(artifactBody)
    ? `<style>${PANE_DEFAULT_CSS}</style>`
    : "";
  const shim = paneShim(embedJson(inputData));
  // `zoom` expands the layout viewport to the full PREVIEW_LOGICAL_WIDTH (so the
  // pane renders its DESKTOP layout) while rasterising into the small frame —
  // see the PREVIEW_FRAME_PX note above. This is the graphics-memory fix; it
  // also reproduces the exact same crop the old 1000px-iframe + transform did.
  const zoomBlock = `<style>html{zoom:${PREVIEW_ZOOM}}</style>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${zoomBlock}
${styleBlock}
<script>${shim}</script>
</head>
<body>
${artifactBody}
</body>
</html>`;
}
