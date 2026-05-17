// Telemetry bootstrap — MUST be the very first import in index.ts.
//
// `@opentelemetry/instrumentation-http` works by monkey-patching Node's
// `http`/`https` modules. That patch only takes effect for code that imports
// those modules AFTER the patch is installed. `@hono/node-server` (and Hono's
// fetch server) sit on top of `http`, so the HTTP instrumentation has to be
// registered before any of that is loaded.
//
// This file does exactly one thing as an import side effect: register the HTTP
// instrumentation. index.ts imports it first — before buildApp/serve — so the
// patch is in place by the time the server modules load. The TracerProvider
// itself is wired later (initTracing, after config is parsed); registering the
// instrumentation early without a provider is fine — spans simply route to a
// no-op tracer until the provider is registered.

import { registerHttpInstrumentation } from "./tracing.js";

registerHttpInstrumentation();
