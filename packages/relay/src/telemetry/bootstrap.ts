// Telemetry bootstrap — MUST be the very first import in index.ts.
//
// OTel auto-instrumentation works by monkey-patching the modules it targets.
// A patch only takes effect for code that imports the target module AFTER the
// patch is installed, so every instrumentation must be registered up front:
//
//   - `@opentelemetry/instrumentation-http` patches Node's `http`/`https`.
//     `@hono/node-server` sits on top of `http`, so HTTP instrumentation must
//     be registered before that loads.
//   - `@prisma/instrumentation` hooks Prisma's tracing helper and must be
//     active before `@prisma/client` is imported by src/db.ts.
//   - `@opentelemetry/instrumentation-pg` patches the `pg` driver (Postgres
//     engine only) and must likewise precede the client load.
//
// This file does exactly one thing as an import side effect: register all of
// the above. index.ts imports it FIRST — before config/db/buildApp/serve — so
// every patch is in place before the instrumented modules load. The
// TracerProvider itself is wired later (initTracing, after config is parsed);
// registering instrumentation early without a provider is fine — spans simply
// route to a no-op tracer until the provider is registered.

import { registerHttpInstrumentation } from "./tracing.js";

registerHttpInstrumentation();
