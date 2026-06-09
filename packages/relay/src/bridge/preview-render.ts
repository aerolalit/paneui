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
// `data:` and `attachment:` are retained for inline bytes and the legacy
// protocol slot. Returned as the joined header value.
export function buildPaneCsp(imgMediaOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: attachment: ${imgMediaOrigin}`,
    `media-src attachment: ${imgMediaOrigin}`,
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
//   - uploadBlob/downloadBlob/saveBlob: reject — a thumbnail can't broker blobs
// `__PANE_INPUT__` is the embedded-JSON placeholder filled by the caller.
function paneShim(inputDataLiteral: string): string {
  return `(function(){
  var inputData = ${inputDataLiteral};
  var noop = function(){};
  var unsub = function(){ return noop; };
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
    uploadBlob: function(){ return Promise.reject(new Error("preview: blobs unavailable")); },
    downloadBlob: function(){ return Promise.reject(new Error("preview: blobs unavailable")); },
    saveBlob: function(){ return Promise.reject(new Error("preview: blobs unavailable")); }
  };
  try { Object.freeze(pane.state); Object.freeze(pane); } catch (e) {}
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
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${styleBlock}
<script>${shim}</script>
</head>
<body>
${artifactBody}
</body>
</html>`;
}
