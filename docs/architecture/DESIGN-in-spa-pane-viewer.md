# In-SPA Pane Viewer (design note)

Status: **PROPOSED** — not built. Captures the design for folding pane viewing
into the owner `/home` SPA so opening a pane no longer reloads the document.

## Problem

Opening a pane from the owner dashboard is a **full-page navigation**, and
returning loses your place in the list.

Two compounding causes:

1. **Clicking a pane is a document load, not SPA routing.** Each `.pane-row`
   carries `data-href="/panes/{id}"` and the click handler does
   `location.href = row.getAttribute('data-href')`
   (`packages/relay/src/http/routes/owner-shell-spa.ts:2175`). That tears down
   the `/home` document — including the panes list and its scroll position — and
   loads a separate document rendered by `renderShell()`.

2. **Returning forcibly scrolls to top.** On Back, `/home` boots and runs
   `activate(viewFromHash())` (`owner-shell-spa.ts:3126`). Because the URL is
   `/home#panes` it re-activates the panes view, and `activate()` unconditionally
   runs `document.querySelector('.main').scrollTop = 0`
   (`owner-shell-spa.ts:1692`). Any scroll the browser might have restored is
   stomped. (`.main` is the `overflow-y:auto` scroll container, not the window.)

Beyond the scroll symptom, the full reload is **wasteful**: the `/home` shell
server-renders *every* view inline (Home, Panes, Templates, Explore, Agents,
Settings) plus the large `owner-shell-css.ts` string and the full SPA JS. Today
that whole document is rebuilt and re-run on every Back from a pane.

## Decision

Make pane viewing an **in-SPA route** inside `/home`: open a pane via
`history.pushState` into a `data-view="pane"` view that mounts the pane iframe
inline; close it via `popstate`, which simply hides the view and reveals the
already-mounted panes list. The list DOM never unmounts (just `display:none`),
so its scroll survives for free — no save/restore workaround needed.

This pays the shell-render cost **once per session**; every subsequent pane
open/close is a `display` toggle plus one iframe mount/unmount.

### Why not the lighter options

- **Save/restore `.main.scrollTop`** (sessionStorage on `pagehide`, restore on
  load): fixes the scroll symptom only. Each pane open still reloads the whole
  shell. A workaround, not an improvement.
- **Lean on bfcache**: fragile — silently disabled by `Cache-Control: no-store`
  or `unload`/`beforeunload` handlers, and unreliable across browsers/mobile.

The in-SPA route is the only option that removes the wasted work *and* fixes
scroll as a side effect. Cost is correctness complexity (WS lifecycle + iframe
teardown), which is acceptable here.

## The duplication problem (and why it's already mostly solved)

We still need the **standalone** shell for token / public viewing — `/s/:token`,
where the viewer is **not logged in** and there is no `/home` SPA to mount into.
So we will have two surfaces rendering the same pane viewer. The goal is to share
everything except auth.

The codebase is already factored for this:

- **`renderShell(args: ShellArgs)`** (`bridge/routes.ts:1023`) is a **single,
  auth-mode-agnostic** function. It already serves **both** the owner route
  `/panes/:id` (`owner-shell.ts:216`) and the public token route `/s/:token`
  (`bridge/routes.ts:410`). The only differences are three `ShellArgs` fields:
  - `iframeContentUrl` — `/panes/:id/content` vs `/s/:token/content`
  - `wsTicketUrl` — `/panes/:id/ws-ticket` vs `/v1/panes/:id/ws-ticket`
  - `authHeader` — `null` (cookie) vs `Bearer <token>`
- **`SHELL_JS`** (`shell.client.ts`) and **`RUNTIME_JS`** (`runtime.client.ts`)
  are shared client bundles, already exported and reused by both routes.
- The iframe sandbox, CSP, and `/content` body are already identical across
  owner and token modes.

So duplication is minimized by **extending the existing shared function**, not by
copying it. Two refactors:

### 1. Split the document wrapper from the viewer fragment

`renderShell()` today returns a **full HTML document** (doctype, `<head>`, CSP
meta, `<body>`). Split it:

- **`renderPaneViewer(args): string`** — returns just the viewer fragment: the
  header chrome (brand, presence pill, Share, optional top-nav), the preamble
  band, and the `<iframe id="frame" sandbox="...">`. No `<html>`/`<head>`.
- **`renderShell(args): string`** — becomes a thin wrapper:
  `renderDocument(head, renderPaneViewer(args))`. Used **unchanged** by
  `/s/:token` and (optionally, see Migration) legacy `/panes/:id`.

The SPA imports `renderPaneViewer(args)` and injects the fragment into its
`<section class="view" data-view="pane">` container — same markup, no document.

### 2. Turn `shell.client.ts` into a mount/destroy component

Today `SHELL_JS` auto-boots against a single global `#frame` on document load.
Refactor it into a class with an explicit lifecycle:

```
class PaneViewer {
  mount(container, args)   // wire WS via wsTicketUrl, attach postMessage proxy,
                           // set iframe.src = iframeContentUrl
  destroy()                // close WS, remove postMessage listener,
                           // null the iframe src, drop the element
}
```

- **Standalone document** (`/s/:token`, public): boots once —
  `new PaneViewer().mount(document.querySelector('#pane-root'), args)` — and
  never destroys (the tab *is* the pane).
- **SPA** (`/home`): on route-enter, `mount()`; on `popstate` away, `destroy()`.
  `destroy()` is the **OOM-safety hook** (see Risks).

The owner-vs-token difference stays exactly where it already is — the three
`ShellArgs` fields. `mount()` takes them verbatim. **No new branching**: the SPA
passes owner-mode args (cookie auth, `/panes/:id/...`), the token document passes
token-mode args. Net new public/token-only code is just the document wrapper +
`authHeader`, both of which already exist.

## SPA routing model

- **New view**: `data-view="pane"`, added to `VIEWS`. Unlike the other views it
  is **not** server-rendered with content — it's an empty mount point the SPA
  fills on demand.
- **Open**: click handler changes from `location.href = '/panes/' + id` to:
  ```
  history.pushState({ pane: id, prev: currentView }, '', '/panes/' + id);
  enterPaneView(id);   // fetch ShellArgs, renderPaneViewer, mount PaneViewer
  ```
  All the existing `location.href = '/panes/' + id` spots
  (`owner-shell-spa.ts:2163, 2175, 2314, 2679, 2741, 2913, 3173`) route through
  one `openPane(id)` helper.
- **Close / Back**: `popstate` → if leaving a pane view, `viewer.destroy()` and
  `activate(prevView)`. The panes list reappears with its scroll intact because
  it was only `display:none`, never unmounted.
- **Deep link / refresh on `/panes/:id`**: the server still must answer
  `GET /panes/:id` for a cold load (someone opening the URL directly, or
  refreshing). Two choices:
  - **(a) Keep the standalone document** at `/panes/:id` for cold loads; the SPA
    only *intercepts* in-session navigations. Simplest, zero risk to deep links.
    Cost: a cold `/panes/:id` is still a standalone page (fine — there's no list
    to preserve on a cold load anyway).
  - **(b) Redirect `/panes/:id` cold loads to `/home` + open the pane** from the
    SPA. Unifies the surface but adds a redirect hop and a flash of the
    dashboard. **Recommend (a).**
- **`scrollTop = 0` fix**: make the reset fire only on *user-initiated* view
  switches (nav clicks / hashchange to a different view), never on the initial
  `activate(viewFromHash())` at load or on `popstate` back to `panes`.

## WebSocket lifecycle

The single biggest correctness concern. Today each `/panes/:id` document mints
its own ws-ticket (`POST .../ws-ticket`) and opens one WS for the page's
lifetime; closing the tab tears it down.

In-SPA, the WS must be **owned by `PaneViewer`** and tied to `mount`/`destroy`:

- `mount()` → POST `wsTicketUrl` (with `authHeader` if present) → open WS.
- `destroy()` → `ws.close()`, clear reconnect timers, drop listeners.
- Switching pane A → pane B in-session = `destroy()` A then `mount()` B (no
  shared connection across panes in v1 — keep it simple; a single multiplexed
  shell WS is a possible later optimization).

This is also where the **shared `PaneViewer` pays off**: the standalone token
document and the SPA use the *same* connect/close code; only the args differ.

## CSP

The iframe `/content` body already ships its own CSP (`buildPaneCsp()`) and the
sandbox attributes are unchanged
(`sandbox="allow-scripts allow-forms allow-downloads
allow-top-navigation-by-user-activation"`). Mounting the same iframe inside the
SPA does not relax isolation — the iframe is still a separate document with the
same sandbox + CSP. The **SPA document's** own CSP must allow the `frame-src`
for `/panes/:id/content` (it already frames preview iframes, so this is in place).

## Risks

- **Iframe / WS leak → renderer OOM.** This is the exact failure class fixed in
  #561 / #563 / #565 (preview iframes that mounted on scroll and never unmounted
  grew unbounded until the renderer OOM'd). The in-SPA pane viewer adds one
  *live* pane iframe on top of the gated preview iframes. **`destroy()` on
  route-leave is load-bearing** — it must null the iframe `src`, remove it from
  the DOM, and close the WS. A leaked viewer reintroduces the OOM. Add a test
  that asserts live-iframe count returns to baseline after open→back.
- **Chrome duplication drift.** Mitigated by `renderPaneViewer()` being the
  single source for header/preamble markup across both surfaces.
- **Deep-link regressions.** Mitigated by keeping the standalone `/panes/:id`
  document for cold loads (option (a)).
- **History edge cases** (double-back, forward into a destroyed pane): covered by
  storing `{ pane, prev }` in `pushState` state and reconstructing on `popstate`.

## Migration / sequencing

1. **Extract** `renderPaneViewer()` out of `renderShell()`; `renderShell()`
   becomes the wrapper. No behaviour change — `/s/:token` and `/panes/:id` still
   render identical documents. Ship + verify.
2. **Refactor** `shell.client.ts` into `PaneViewer` with `mount/destroy`. The
   standalone documents call `mount()` once. No behaviour change. Ship + verify.
3. **Add** the `data-view="pane"` SPA view + `openPane()` / `popstate` wiring;
   intercept in-session navigations only. Keep `/panes/:id` standalone for cold
   loads. Fix the `scrollTop=0` reset.
4. **Test**: live-iframe count returns to baseline after open→back; WS closes on
   leave; scroll position preserved; deep-link cold load still works; token
   `/s/:token` unchanged.

Each step is independently shippable and reversible. Steps 1–2 are pure
refactors that *also* tighten the shared-shell story even if step 3 is deferred.

## Out of scope

- Multiplexed single-WS shell (per-pane WS is fine for v1).
- Public/token surface becoming an SPA (it stays a standalone document — correct
  for logged-out viewers).
- Prefetching pane content on row hover (possible later perf win).
