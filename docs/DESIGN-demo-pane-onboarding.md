# Design Note: `pane demo` — the self-teaching tutorial pane

Companion to `README.md`, `docs/ROADMAP.md`, and `docs/architecture/phase-3-human-side.md`.
This gives a concrete shape to two roadmap lines: the **"Dogfood demo"** and the
**"30-second demo clip"** under v1. No code yet — this is the design we implement against.

Status: **proposed**. Decisions below are marked **DECIDED** (settled here) or **OPEN**
(decide at implementation, with a lean).

---

## 1. Why this exists: the onboarding gap, correctly framed

The recurring onboarding question was *"after someone installs, how do they get redirected
to the relay / a home page?"* The answer that fell out of working it through:

**There is no relay home page to redirect to, and there shouldn't be one in v1.**

### The three roles — and why they collapse to two

| Role | Who | What they touch | Account in v1? |
|---|---|---|---|
| **End human** | Receives a pane URL from an agent, interacts | The `/s/:token` pane page | No — the URL token *is* their auth |
| **Operator** | The **developer running the agent**. Installs the CLI, runs `pane agent register`, holds the API key. Their agent *generates* panes | CLI + the key in `~/.config/pane/config.json` | No login, no dashboard — CLI only |
| **Relay host** | Whoever deploys the relay (self-hoster, or the hosted instance) | Docker, env, the DB | No admin UI — config only |

**Most of the time the operator and the end human are the same person** — a developer
running their own agent (cron job, Claude Code, a bot) who also receives the pane it hands
out. So the three roles collapse to two: **the developer/user** and **the relay host**.

This dissolves the "redirect" worry entirely. The developer's own agent/CLI hands them the
URL — *that is the redirect*. The CLI prints it; `pane session watch` surfaces it. Nobody logs
into a relay home page, because the link arrives through the thing they just set up.

A full operator console — login, dashboard home, tabs, settings — is **v2 / hosted**, per
`docs/ROADMAP.md` ("the proper hosted product… a console… only if v1 gets a pulse"). The
magic-link `Human`/`Login`/`MagicLink` models exist in the schema but nothing in v1 consumes
them. **We do not build a dashboard to solve onboarding.** We make the *first pane* do the job.

---

## 2. Goal

The first pane a new user ever sees must do three jobs at once:

1. **Teach the model** — agent hands you a UI → you interact → it becomes structured data →
   the loop closes.
2. **Prove the install works** end-to-end — CLI auth, relay reachable, WebSocket up, a real
   round-trip — without the user having to reason about any of it.
3. **Be the proof** — it teaches pane *by being a pane*. Maximum dogfood.

One command (`pane demo`), one browser tab, and the *"I clicked something and my agent saw it"*
moment lands.

---

## 3. The core mechanic: a *real* round-trip, not a mockup

`pane demo` is not a static page. The command:

1. Creates a session with the bundled tutorial artifact (+ its event schema).
2. Opens the URL in the browser (or prints it if no browser is available).
3. **Runs a tiny built-in agent loop in the same terminal process** that watches the session,
   reacts to each interaction with a state update, and drives the tutorial forward.
4. **Echoes every received event to the terminal** as it arrives.

That step 4 is the whole trick: the user sees their click land in **both** places — the pane
visibly reacts *and* their terminal prints the same event. "My agent saw it" stops being an
abstraction. It also silently exercises every moving part of the install, so a successful demo
*is* a successful smoke test.

---

## 4. Scene-by-scene artifact spec

Six scenes. **Interaction-driven**: each scene advances only when the user emits the event it
asks for, and the demo-agent loop's reply is what reveals the next scene. (Rationale in §6.)

Event schema (the contract `pane demo` registers for the session):

| Event type | Emitted by | Payload | Purpose |
|---|---|---|---|
| `demo:hello` | human | `{}` | First click — the round-trip proof |
| `demo:form` | human | `{ name: string, choice: "build"\|"explore"\|"watch" }` | Structured-data lesson |
| `demo:advance` | agent | `{ scene: number, note?: string }` | Agent drives the next scene into view |
| `demo:echo` | agent | `{ received: object }` | Agent reflects the user's payload back into the pane |
| `demo:done` | agent | `{}` | Tutorial complete; render the CTA |

**Scene 1 — Hook.** The pane animates in: *"You're looking at a pane."* Self-referential. One
line establishing that this rich UI was handed over by an agent, by URL. CTA: a single primary
button, *"Show me how →"* → emits `demo:hello`.

**Scene 2 — The model.** On the agent's `demo:advance{scene:2}`, an animated diagram draws the
round-trip: `your terminal (agent)  ⇄  relay  ⇄  this page`. Callout: *"You ran `pane demo` —
that command is acting as your agent right now. It's watching this session."*

**Scene 3 — First emit (the proof beat).** A single button: *"Click me."* → emits `demo:hello`
(reused; or a `demo:click` if we want Scene 1's button to be navigation-only — see OPEN-2). The
demo-agent loop receives it, prints it to the terminal, and replies `demo:advance{scene:3,
note}` → the pane shows *"✅ Your agent just received your click."* and points: *"Look at your
terminal — it printed the same event."* This is the highest-value moment in the whole flow.

**Scene 4 — Structured data.** A tiny form: a name field + a 3-way choice. On submit → emits
`demo:form{name, choice}`. The agent replies `demo:echo{received}` and the pane renders the
**exact structured payload** it sent back: *"Your agent received: `{ name: …, choice: … }`."*
Lesson: interactions aren't clicks, they're typed, validated data.

**Scene 5 — State / the log.** The agent advances to a view of `pane.state` as an append-only
event log — the user's own `demo:hello` and `demo:form` are listed. *"Everything you did is a
log your agent can read."* Show the CLI equivalent inline: `pane session show <id>`.

**Scene 6 — Now you.** On `demo:done`, render the CTA: the ~3 lines to create your own pane,
the skill pointer (`pane skill show`), and a docs link. *"That's it — now go hand one to a
human."* The terminal loop prints the same snippet and exits cleanly (see §5).

---

## 5. `pane demo` command behavior

- **New top-level command** `pane demo` (sits alongside the existing `pane session
  create/watch/show/send` verbs; reuses the same config/profile resolution).
- **Run-to-completion.** The loop reacts through Scenes 1–6, sends `demo:done`, prints the
  "build your own" snippet, and exits 0. No lingering daemon. **DECIDED** (OPEN-2 resolved).
- **No browser?** Print the URL and a one-liner: *"Open this to start the tour."* The loop
  still runs and still echoes events, so it works over SSH / headless too.
- **Cleanup.** The demo session is created with a short TTL so the relay's sweeper reclaims it;
  the command also best-effort `DELETE`s the session on exit.
- **Failure is the smoke test.** If registration/auth/WS is broken, `pane demo` fails loudly at
  the exact failing step — which is precisely the diagnostic a new user needs.

---

## 6. Decisions (the four open questions, resolved)

- **DECIDED — Interaction-driven, not auto-advancing.** The user must emit to progress. Auto-
  advance would let someone watch the whole thing without ever completing a round-trip, which
  defeats job #2 (prove the install). A subtle "skip" affordance is allowed but it jumps to
  Scene 6, it doesn't fake the round-trip.
- **DECIDED — Run-to-completion, then exit.** See §5. A persistent process is a worse first
  impression (it looks hung) and isn't needed; re-running `pane demo` is cheap.
- **DECIDED — Landing page uses simulated mode.** The same artifact is mounted on the landing
  page with a **scripted echo** standing in for the agent (Scenes 3–4 play canned replies). No
  live relay session is provisioned for anonymous visitors → no abuse surface, no cost, no auth.
  One artifact, two mounts: **live** (post-install, real loop) and **simulated** (pre-install).
- **DECIDED — CSS keyframes + Web Animations API, not GSAP.** The artifact runs under the
  sealed content CSP (`default-src 'none'`, `script-src 'unsafe-inline'`, **`connect-src
  'none'`**) — no external resources, no CDN, no fetch. Everything ships inline. A handful of
  scene transitions don't justify bundling GSAP into the blob; native CSS/WAAPI keeps the
  artifact dependency-free and small.

### Still OPEN

- **OPEN-1 — Where the artifact source lives.** Candidates: (a) a file in `packages/cli`
  shipped as a string constant, (b) `packages/relay` static asset reused by both the CLI demo
  and the landing page, (c) a tiny `packages/demo` workspace. *Lean: (b)* — the relay already
  serves static assets and the landing page can import the same file, avoiding a second copy.
- **OPEN-2 — One human event or two in Scenes 1/3.** Reuse `demo:hello` for both the Scene-1
  "Show me how" and the Scene-3 "Click me", or split into `demo:start` + `demo:hello`. *Lean:
  split* — cleaner schema, and Scene 1 reads as navigation while Scene 3 reads as the proof.
- **OPEN-3 — Landing-page simulated mode: inline JS or a recorded event trace.** *Lean: a small
  recorded trace* the artifact replays, so live and simulated share one render path.

---

## 7. Build order

1. **The artifact + event schema** (Scenes 1–6), self-contained, CSP-clean, with a tiny
   `mode: "live" | "simulated"` switch.
2. **`pane demo`** — session create + the watch/react loop + terminal echo + clean exit.
3. **Landing-page mount** — drop the same artifact onto `site/index.html` in simulated mode as
   the "watch it work" demo.

Highest leverage first: the artifact is reused by both surfaces, and `pane demo` is the piece
that turns "installed" into "I get it."

---

## 8. Explicitly out of scope

- Any operator dashboard / login / console — that's v2 / hosted (§1).
- Persisting demo runs, analytics on the demo, or gating it behind an account.
- Multi-step branching tutorials. Six linear scenes, one happy path.
