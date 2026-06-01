# @paneui/core

Typed client for the Pane relay HTTP + WebSocket API. Framework-free: no argv,
no MCP, no server dependencies — just the relay protocol expressed as typed
operations.

## Runtime requirement: Node.js >= 20

`@paneui/core` targets the **Node.js** runtime (>= 20, as declared in
`package.json`'s `engines`). It is *framework*-free, not *runtime*-free.

The WebSocket transport (`openStream`) uses the [`ws`](https://www.npmjs.com/package/ws)
package rather than the global `WebSocket`. `ws` exposes a Node-style event API
(`socket.on("message", ...)`, custom upgrade headers such as `Authorization`)
that the browser `WebSocket` does not, and the relay protocol relies on it.
Because of this, `@paneui/core` is **not** intended to run in a browser or other
non-Node runtime as-is.

The HTTP pane (`PaneClient`, `registerAgent`) uses the standard `fetch` API
and is runtime-agnostic; only `openStream` carries the Node constraint.

If you need a browser client, treat that as separate future work — it would
need a `ws`-vs-global-`WebSocket` abstraction rather than the unconditional
`import { WebSocket } from "ws"` used today.

## Exports

- `PaneClient` / `PaneApiError` — typed HTTP operations against a relay.
- `openStream` — WebSocket stream (replay-on-connect, then live). **Node only.**
- `registerAgent` — agent registration helper.
- `artifactSchema`, `callbackSchema`, `createPaneSchema` — Zod schemas.
