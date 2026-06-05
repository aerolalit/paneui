// The `pane demo` tutorial artifact — a self-contained HTML page that teaches
// Pane *by being a pane*. Authored as a string constant (OPEN-1 fallback (a)):
// the CLI ships independently of the relay and talks to a remote relay over
// HTTP, so the artifact has to travel inside the `POST /v1/panes` create body
// (`template.source`). A relay static asset would mean fetching the artifact
// *back* from the relay before sending it on — circular, network-dependent,
// and broken offline. A build-time string is the single source the CLI demo
// uses today; a future landing-page mount can inline the same HTML from this
// module (it's a plain ESM export).
//
// Constraints (the content-frame CSP, src/bridge/routes.ts):
//   default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
//   img-src data: attachment:; connect-src 'none'
// => fully self-contained: inline CSS + inline JS, NO external resources
//    (no CDN, no remote fonts, no fetch). Animation is CSS keyframes + the
//    Web Animations API only.
//
// Runtime surface used (confirmed against
// src/bridge/client/runtime.client.ts): pane.emit(type, data?), pane.on(type,
// handler), pane.inputData, pane.ready. Nothing else.
//
// Event schema (the contract `pane demo` registers — kept here so the artifact
// and its schema stay in one file and cannot drift):
//   demo.start   page  {}                          — Scene 1 "Show me how"
//   demo.hello   page  {}                          — Scene 3 "Click me" (the proof)
//   demo.form    page  { name, choice }            — Scene 4 structured data
//   demo.advance agent { scene, note? }            — drive the next scene in
//   demo.echo    agent { received }                — reflect the form payload back
//   demo.done    agent {}                          — render the final CTA

/**
 * The tutorial event schema, in the legacy `{ events: { type: { payload,
 * emittedBy } } }` shape (still fully supported; see skills/pane/SKILL.md).
 * Exported so the demo command and its tests reference the one definition.
 */
export const DEMO_EVENT_SCHEMA = {
  events: {
    "demo.start": {
      emittedBy: ["page"],
      payload: { type: "object", additionalProperties: false },
    },
    "demo.hello": {
      emittedBy: ["page"],
      payload: { type: "object", additionalProperties: false },
    },
    "demo.form": {
      emittedBy: ["page"],
      payload: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 80 },
          choice: { type: "string", enum: ["build", "explore", "watch"] },
        },
        required: ["choice"],
        additionalProperties: false,
      },
    },
    "demo.advance": {
      emittedBy: ["agent"],
      payload: {
        type: "object",
        properties: {
          scene: { type: "integer" },
          note: { type: "string" },
        },
        required: ["scene"],
        additionalProperties: false,
      },
    },
    "demo.echo": {
      emittedBy: ["agent"],
      payload: {
        type: "object",
        properties: { received: { type: "object" } },
        required: ["received"],
        additionalProperties: false,
      },
    },
    "demo.done": {
      emittedBy: ["agent"],
      payload: { type: "object", additionalProperties: false },
    },
  },
} as const;

/** The tab title for the demo pane. */
export const DEMO_TITLE = "Pane — the 60-second tour";

/** The auto-created template's name (inline-form `--name`). */
export const DEMO_TEMPLATE_NAME = "Pane demo tour";

// The artifact HTML. One document, no external resources. The mode switch
// (`live` | `simulated`) is read from inputData so a future landing-page
// mount can drop the same blob in `simulated` mode without a rewrite — in
// LIVE mode (the only mode this PR ships) the real agent loop drives every
// agent event over the relay; SIMULATED is a deliberate no-op placeholder
// here (the scripted-echo path is a fast-follow, OPEN-3).
export const DEMO_ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pane — the 60-second tour</title>
<style>
  :root {
    --bg: #0b0d12;
    --panel: #141821;
    --ink: #e7ebf3;
    --muted: #97a1b5;
    --line: #232a37;
    --accent: #6ea8fe;
    --accent-2: #8b78ff;
    --ok: #46d39a;
    --radius: 14px;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
      Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background:
      radial-gradient(1100px 600px at 50% -10%, #1a2030 0%, var(--bg) 60%);
    color: var(--ink);
    font-family: var(--font);
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100%;
    padding: 24px;
    line-height: 1.5;
  }
  .stage {
    width: 100%;
    max-width: 560px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    overflow: hidden;
  }
  .progress {
    display: flex;
    gap: 6px;
    padding: 16px 22px 0;
  }
  .progress i {
    flex: 1;
    height: 3px;
    border-radius: 3px;
    background: var(--line);
    transition: background 0.4s ease;
  }
  .progress i.on { background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
  .body { padding: 26px 30px 30px; }
  .scene { display: none; }
  .scene.active { display: block; }
  .kicker {
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 10px;
  }
  h1 {
    font-size: 24px;
    line-height: 1.25;
    margin: 0 0 12px;
    letter-spacing: -0.01em;
  }
  p { margin: 0 0 14px; color: #c7cedd; }
  p.lead { color: var(--ink); font-size: 16px; }
  .muted { color: var(--muted); font-size: 14px; }
  button.cta {
    appearance: none;
    border: 0;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    color: #0b0d12;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    padding: 12px 20px;
    border-radius: 10px;
    margin-top: 6px;
    transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.2s ease;
    box-shadow: 0 6px 18px rgba(110, 168, 254, 0.28);
  }
  button.cta:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(110, 168, 254, 0.38); }
  button.cta:active { transform: translateY(0); }
  button.cta:disabled { opacity: 0.55; cursor: default; transform: none; box-shadow: none; }
  .diagram {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 6px 0 18px;
    padding: 18px 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #10141d;
  }
  .node {
    flex: 1;
    text-align: center;
    font-size: 13px;
    color: var(--ink);
    padding: 12px 6px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: #161b26;
  }
  .node .ic { font-size: 20px; display: block; margin-bottom: 4px; }
  .node small { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; }
  .wire { color: var(--accent); font-size: 18px; opacity: 0.7; }
  .field { display: block; margin: 0 0 14px; }
  .field span { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input[type="text"] {
    width: 100%;
    font: inherit;
    color: var(--ink);
    background: #0e121a;
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 11px 12px;
    outline: none;
  }
  input[type="text"]:focus { border-color: var(--accent); }
  .choices { display: flex; gap: 8px; flex-wrap: wrap; }
  .choices label {
    flex: 1;
    min-width: 120px;
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 11px 12px;
    cursor: pointer;
    background: #0e121a;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .choices label.sel { border-color: var(--accent); background: #141b2b; }
  .choices input { position: absolute; opacity: 0; pointer-events: none; }
  .choices b { display: block; font-size: 14px; }
  .choices em { display: block; font-style: normal; color: var(--muted); font-size: 12px; }
  pre {
    margin: 0 0 14px;
    padding: 14px 16px;
    background: #0e121a;
    border: 1px solid var(--line);
    border-radius: 10px;
    font-family: var(--mono);
    font-size: 13px;
    color: #cdd6e6;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  pre .k { color: var(--accent); }
  pre .s { color: var(--ok); }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    color: var(--ok);
    border: 1px solid rgba(70, 211, 154, 0.35);
    background: rgba(70, 211, 154, 0.08);
    padding: 6px 11px;
    border-radius: 999px;
    margin: 0 0 14px;
  }
  .point {
    border-left: 2px solid var(--accent);
    padding: 2px 0 2px 12px;
    margin: 0 0 8px;
    color: var(--ink);
  }
  .log { list-style: none; margin: 0 0 16px; padding: 0; }
  .log li {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 9px 12px;
    border: 1px solid var(--line);
    border-radius: 9px;
    margin-bottom: 7px;
    background: #0e121a;
    font-size: 13px;
  }
  .log code { font-family: var(--mono); color: var(--accent); }
  .log .who { color: var(--muted); font-size: 11px; margin-left: auto; }
  .anim-in { animation: rise 0.5s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
  @keyframes rise {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .anim-in { animation: none; }
    * { transition: none !important; }
  }
</style>
</head>
<body>
  <main class="stage" role="application" aria-label="Pane tutorial">
    <div class="progress" aria-hidden="true">
      <i data-step="1"></i><i data-step="2"></i><i data-step="3"></i>
      <i data-step="4"></i><i data-step="5"></i><i data-step="6"></i>
    </div>
    <div class="body">
      <!-- Scene 1 — Hook -->
      <section class="scene" data-scene="1">
        <p class="kicker">A pane</p>
        <h1>You're looking at a pane.</h1>
        <p class="lead">
          An agent just handed you this UI — by URL, nothing installed. Whatever
          you do here turns into structured data the agent reads back.
        </p>
        <p class="muted">Let's prove it in about a minute.</p>
        <button class="cta" id="b-start" type="button">Show me how &rarr;</button>
      </section>

      <!-- Scene 2 — The model -->
      <section class="scene" data-scene="2">
        <p class="kicker">The round-trip</p>
        <h1>How it works</h1>
        <div class="diagram" aria-hidden="true">
          <div class="node"><span class="ic">&#9881;</span>your terminal<small>the agent</small></div>
          <span class="wire">&#8644;</span>
          <div class="node"><span class="ic">&#9729;</span>relay<small>routes events</small></div>
          <span class="wire">&#8644;</span>
          <div class="node"><span class="ic">&#9638;</span>this page<small>the pane</small></div>
        </div>
        <p>
          You ran <code>pane demo</code> &mdash; that command is acting as your
          agent right now. It's watching this session over a WebSocket.
        </p>
        <button class="cta" id="b-hello" type="button">Click me</button>
      </section>

      <!-- Scene 3 — First emit (the proof) -->
      <section class="scene" data-scene="3">
        <div class="badge">&#10003; Your agent just received your click.</div>
        <h1>That landed in two places.</h1>
        <p class="point">Look at your terminal — it printed the same event.</p>
        <p>
          The click became a <code>demo.hello</code> event, streamed to the
          agent, which streamed a reply back to redraw this page. No polling, no
          refresh.
        </p>
        <p class="muted">Now the interesting part: typed, validated data.</p>
        <button class="cta" id="b-to-form" type="button">Next &rarr;</button>
      </section>

      <!-- Scene 4 — Structured data -->
      <section class="scene" data-scene="4">
        <p class="kicker">Structured data</p>
        <h1>Interactions aren't clicks — they're data.</h1>
        <label class="field">
          <span>Your name (optional)</span>
          <input type="text" id="f-name" autocomplete="off" maxlength="80"
            placeholder="e.g. Sam" />
        </label>
        <div class="field">
          <span>What brought you here?</span>
          <div class="choices" id="f-choices">
            <label data-choice="build"><input type="radio" name="choice" value="build" />
              <b>Build</b><em>wire it into an agent</em></label>
            <label data-choice="explore"><input type="radio" name="choice" value="explore" />
              <b>Explore</b><em>just looking</em></label>
            <label data-choice="watch"><input type="radio" name="choice" value="watch" />
              <b>Watch</b><em>show me more</em></label>
          </div>
        </div>
        <button class="cta" id="b-form" type="button" disabled>Send it &rarr;</button>
        <div id="echo" hidden>
          <div class="badge" style="margin-top:16px">&#10003; Your agent received:</div>
          <pre id="echo-pre"></pre>
          <p class="muted">
            That's the exact payload — typed and validated by the relay before
            the agent ever saw it.
          </p>
        </div>
      </section>

      <!-- Scene 5 — State / the log -->
      <section class="scene" data-scene="5">
        <p class="kicker">The event log</p>
        <h1>Everything you did is a log.</h1>
        <p>
          A pane is an append-only event log your agent can read at any time.
          Here's yours so far:
        </p>
        <ul class="log" id="log"></ul>
        <p class="muted">
          From your terminal that's just:
          <code style="font-family:var(--mono);color:var(--accent)">pane show &lt;id&gt;</code>
        </p>
      </section>

      <!-- Scene 6 — Now you -->
      <section class="scene" data-scene="6">
        <p class="kicker">Your turn</p>
        <h1>That's the whole idea.</h1>
        <p>An agent hands a human a UI, gets structured data back. To build one:</p>
        <pre><span class="k">pane</span> create \\
  --template ./form.html --name "My form" \\
  --event-schema ./schema.json
<span class="k">pane</span> watch &lt;id&gt; --type form.submitted</pre>
        <p>
          The full guide is in the skill:
          <code style="font-family:var(--mono);color:var(--accent)">pane skill show</code>.
        </p>
        <p class="muted">Now go hand one to a human.</p>
      </section>
    </div>
  </main>

<script>
(function () {
  var reduce = false;
  try {
    reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { reduce = false; }

  var scenes = {};
  var nodes = document.querySelectorAll(".scene");
  for (var i = 0; i < nodes.length; i++) {
    scenes[nodes[i].getAttribute("data-scene")] = nodes[i];
  }
  var steps = document.querySelectorAll(".progress i");
  var current = 0;

  function setProgress(n) {
    for (var i = 0; i < steps.length; i++) {
      var step = Number(steps[i].getAttribute("data-step"));
      if (step <= n) steps[i].classList.add("on");
      else steps[i].classList.remove("on");
    }
  }

  // Show a scene by number. Scenes are interaction-driven: scene 1 is shown
  // immediately; every later scene is revealed by an agent reply (demo.advance
  // / demo.echo / demo.done), never by the page on its own.
  function show(n) {
    if (n === current) return;
    var el = scenes[String(n)];
    if (!el) return;
    var prev = current ? scenes[String(current)] : null;
    if (prev) prev.classList.remove("active");
    el.classList.add("active");
    current = n;
    setProgress(n);
    if (!reduce && el.animate) {
      try {
        el.animate(
          [
            { opacity: 0, transform: "translateY(10px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 460, easing: "cubic-bezier(0.2,0.7,0.2,1)" }
        );
      } catch (e) { /* WAAPI unavailable — the scene still shows */ }
    }
    var focusable = el.querySelector("button.cta:not([disabled]), input");
    if (focusable && focusable.focus) {
      try { focusable.focus(); } catch (e) { /* ignore */ }
    }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Render the form payload the agent echoed back, as pretty (highlighted)
  // JSON. Only fields we understand are rendered — never the raw envelope.
  function renderEcho(received) {
    var obj = received && typeof received === "object" ? received : {};
    var parts = [];
    parts.push("{");
    var keys = ["name", "choice"];
    var shown = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        shown.push(
          '  <span class="k">"' + esc(k) + '"</span>: ' +
          '<span class="s">' + JSON.stringify(obj[k]) + "</span>"
        );
      }
    }
    parts.push(shown.join(",\\n"));
    parts.push("}");
    document.getElementById("echo-pre").innerHTML = parts.join("\\n");
    document.getElementById("echo").hidden = false;
  }

  // Render the event log for scene 5 from pane.state — the user's own emits.
  var EVENT_LABEL = {
    "demo.start": "opened the tour",
    "demo.hello": "clicked the button",
    "demo.form": "submitted the form",
  };
  function renderLog() {
    var log = document.getElementById("log");
    if (!log) return;
    log.innerHTML = "";
    var events = [];
    try { events = pane.state.events || []; } catch (e) { events = []; }
    var any = false;
    for (var i = 0; i < events.length; i++) {
      var t = events[i].type;
      if (!Object.prototype.hasOwnProperty.call(EVENT_LABEL, t)) continue;
      any = true;
      var li = document.createElement("li");
      var code = document.createElement("code");
      code.textContent = t;
      var label = document.createElement("span");
      label.textContent = EVENT_LABEL[t];
      var who = document.createElement("span");
      who.className = "who";
      who.textContent = "you";
      li.appendChild(code);
      li.appendChild(label);
      li.appendChild(who);
      log.appendChild(li);
    }
    if (!any) {
      var li2 = document.createElement("li");
      li2.textContent = "Your events will appear here.";
      log.appendChild(li2);
    }
  }

  // --- wiring -----------------------------------------------------------

  // Scene 1 -> demo.start. The agent replies demo.advance{scene:2}.
  document.getElementById("b-start").addEventListener("click", function () {
    var b = this;
    b.disabled = true;
    pane.emit("demo.start", {})["catch"](function () { b.disabled = false; });
  });

  // Scene 2 -> demo.hello (the proof). The agent replies demo.advance{scene:3}.
  document.getElementById("b-hello").addEventListener("click", function () {
    var b = this;
    b.disabled = true;
    pane.emit("demo.hello", {})["catch"](function () { b.disabled = false; });
  });

  // Scene 3 -> reveal the form. This is a local navigation step (no round-trip
  // needed to read the form), so it just shows scene 4.
  document.getElementById("b-to-form").addEventListener("click", function () {
    show(4);
  });

  // Scene 4 — the structured-data form. choice is required; name optional.
  var choiceWrap = document.getElementById("f-choices");
  var formBtn = document.getElementById("b-form");
  var picked = null;
  choiceWrap.addEventListener("change", function (e) {
    var label = e.target.closest ? e.target.closest("label") : null;
    var labels = choiceWrap.querySelectorAll("label");
    for (var i = 0; i < labels.length; i++) labels[i].classList.remove("sel");
    if (label) {
      label.classList.add("sel");
      picked = label.getAttribute("data-choice");
      formBtn.disabled = false;
    }
  });
  formBtn.addEventListener("click", function () {
    if (!picked) return;
    var name = document.getElementById("f-name").value.trim();
    var data = { choice: picked };
    if (name) data.name = name;
    formBtn.disabled = true;
    // The agent replies demo.echo{received} (then walks scenes 5 + 6).
    pane.emit("demo.form", data)["catch"](function () {
      formBtn.disabled = false;
    });
  });

  // --- agent-driven scene changes --------------------------------------

  pane.on("demo.advance", function (ev) {
    var scene = ev && ev.data && Number(ev.data.scene);
    if (scene === 5) renderLog();
    if (scene >= 1 && scene <= 6) show(scene);
  });

  pane.on("demo.echo", function (ev) {
    var received = ev && ev.data ? ev.data.received : null;
    renderEcho(received);
  });

  pane.on("demo.done", function () {
    show(6);
  });

  // First paint. mode is read for forward-compat (a future landing-page mount
  // can pass { mode: "simulated" } and replay a canned trace through the same
  // render path) but LIVE is the only behaviour this build ships.
  pane.ready.then(function () {
    show(1);
  });
  // pane.ready resolves on the init frame; show scene 1 eagerly too so the
  // page is never blank if init is momentarily delayed.
  if (!current) show(1);
})();
</script>
</body>
</html>`;
