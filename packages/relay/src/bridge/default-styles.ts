// Default artifact stylesheet — injected into every /content response so
// agent-authored HTML looks presentable out of the box.
//
// Cascade rules
// -------------
//  - Injected in <head>, BEFORE the agent's own markup is dropped into <body>.
//    Author styles (even in body-position <style> blocks) therefore win at
//    equal specificity.
//  - Element-only selectors. Specificity is (0,0,1) everywhere so a single
//    class in the artifact (`.btn`, `#submit`) reliably overrides anything
//    here. The author keeps full control of bespoke designs.
//
// Opt-out
// -------
//  - If the agent's HTML contains the literal string `data-pane-bare`
//    (anywhere — on `<html>`, `<body>`, or even a meta tag), the route
//    skips injection entirely. The marker is documented in the agent skill.
//
// Trust boundary
// --------------
//  - This CSS is pane-controlled, not agent input. No interpolation, no user
//    values. The string is the same for every request and is shipped
//    verbatim into the wrapper.

export const PANE_DEFAULT_CSS = `:root {
  --pane-bg: #ffffff;
  --pane-fg: #18181b;
  --pane-muted: #6b7280;
  --pane-subtle: #f4f4f5;
  --pane-border: #e4e4e7;
  --pane-accent: #7c3aed;
  --pane-accent-hover: #6d28d9;
  --pane-danger: #dc2626;
  --pane-radius: 8px;
  --pane-font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --pane-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono",
    "Roboto Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --pane-bg: #0b0e14;
    --pane-fg: #e7ecf3;
    --pane-muted: #8a93a6;
    --pane-subtle: #141a26;
    --pane-border: #1f2633;
    --pane-accent: #a78bfa;
    --pane-accent-hover: #c4b5fd;
    --pane-danger: #f87171;
  }
}
* { box-sizing: border-box; }
html { color-scheme: light dark; }
body {
  margin: 0;
  padding: 24px;
  font-family: var(--pane-font);
  font-size: 15px;
  line-height: 1.5;
  color: var(--pane-fg);
  background: var(--pane-bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
h1, h2, h3, h4, h5, h6 {
  margin: 1.2em 0 0.5em;
  line-height: 1.25;
  font-weight: 600;
  letter-spacing: -0.01em;
}
h1 { font-size: 1.75rem; }
h2 { font-size: 1.4rem; }
h3 { font-size: 1.2rem; }
h4 { font-size: 1.05rem; }
h5, h6 { font-size: 1rem; }
p { margin: 0 0 1em; }
a {
  color: var(--pane-accent);
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--pane-accent) 30%, transparent);
}
a:hover { border-bottom-color: var(--pane-accent); }
a:focus-visible { outline: 2px solid var(--pane-accent); outline-offset: 2px; border-radius: 2px; }
small { color: var(--pane-muted); font-size: 0.85em; }
hr {
  border: 0;
  height: 1px;
  background: var(--pane-border);
  margin: 1.5em 0;
}
code {
  font-family: var(--pane-mono);
  font-size: 0.9em;
  background: var(--pane-subtle);
  padding: 1px 5px;
  border-radius: 4px;
}
pre {
  font-family: var(--pane-mono);
  font-size: 0.9em;
  background: var(--pane-subtle);
  padding: 12px 14px;
  border-radius: var(--pane-radius);
  overflow-x: auto;
  line-height: 1.45;
}
pre code { background: transparent; padding: 0; border-radius: 0; }
blockquote {
  margin: 0 0 1em;
  padding: 4px 0 4px 14px;
  border-left: 3px solid var(--pane-border);
  color: var(--pane-muted);
}
ul, ol { padding-left: 1.5em; margin: 0 0 1em; }
li { margin: 0.15em 0; }
table {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 1em;
  font-size: 0.95em;
}
th, td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--pane-border);
}
th { font-weight: 600; color: var(--pane-muted); }
label {
  display: inline-block;
  font-size: 0.9rem;
  font-weight: 500;
  margin-bottom: 4px;
  color: var(--pane-fg);
}
input, textarea, select {
  font: inherit;
  color: inherit;
  background: var(--pane-bg);
  border: 1px solid var(--pane-border);
  border-radius: var(--pane-radius);
  padding: 8px 10px;
  width: 100%;
  max-width: 100%;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
input[type="checkbox"], input[type="radio"] {
  width: auto;
  margin-right: 6px;
  accent-color: var(--pane-accent);
}
input[type="range"] { padding: 0; }
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--pane-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--pane-accent) 25%, transparent);
}
textarea { min-height: 80px; resize: vertical; }
button, input[type="submit"], input[type="button"], input[type="reset"] {
  font: inherit;
  font-weight: 500;
  background: var(--pane-accent);
  color: #ffffff;
  border: 1px solid var(--pane-accent);
  border-radius: var(--pane-radius);
  padding: 8px 16px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
button:hover, input[type="submit"]:hover, input[type="button"]:hover, input[type="reset"]:hover {
  background: var(--pane-accent-hover);
  border-color: var(--pane-accent-hover);
}
button:focus-visible, input[type="submit"]:focus-visible {
  outline: 2px solid var(--pane-accent);
  outline-offset: 2px;
}
button:disabled, input:disabled, textarea:disabled, select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
fieldset {
  border: 1px solid var(--pane-border);
  border-radius: var(--pane-radius);
  padding: 14px 16px 4px;
  margin: 0 0 1em;
}
legend { padding: 0 6px; color: var(--pane-muted); font-size: 0.85rem; }
form > * + * { margin-top: 12px; }
details {
  border: 1px solid var(--pane-border);
  border-radius: var(--pane-radius);
  padding: 8px 12px;
  margin: 0 0 1em;
}
summary { cursor: pointer; font-weight: 500; }
img, video, audio, canvas, svg { max-width: 100%; }
::selection { background: color-mix(in srgb, var(--pane-accent) 30%, transparent); }`;

// The string `data-pane-bare` opts an artifact out of the default sheet —
// the agent puts it on `<html>` (e.g. `<html data-pane-bare>`) or anywhere
// else in their HTML and the relay skips the <style> injection.
export const BARE_MARKER = "data-pane-bare";

export function shouldInjectDefaults(artifactBody: string): boolean {
  return !artifactBody.includes(BARE_MARKER);
}
