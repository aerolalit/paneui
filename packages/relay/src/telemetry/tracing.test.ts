// Unit tests for the tracing helpers.
//
// We deliberately do NOT test the HTTP auto-instrumentation end to end here —
// span capture through the instrumentation is timing/ordering sensitive and
// would be flaky in a unit suite. Instead we verify the two pieces of logic
// the relay owns directly:
//   1. recordExceptionOnActiveSpan() enriches whatever span is active.
//   2. initTracing() is a no-op in non-azure modes (no provider, no exporter).
// The HTTP-instrumentation ordering itself is guaranteed structurally:
// telemetry/bootstrap.ts is the first import in index.ts and registers the
// instrumentation before @hono/node-server (and thus `http`) is loaded.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { context, trace } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { recordExceptionOnActiveSpan } from "./tracing.js";
import { loadConfig } from "../config.js";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

beforeAll(() => {
  // NodeTracerProvider.register() installs an AsyncLocalStorage context
  // manager — required for trace.getActiveSpan() / context.with() to actually
  // propagate the active span. A bare BasicTracerProvider leaves the no-op
  // context manager in place, so getActiveSpan() would always return nothing.
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

describe("recordExceptionOnActiveSpan", () => {
  it("records the exception and sets ERROR status on the active span", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("req");
    context.with(trace.setSpan(context.active(), span), () => {
      recordExceptionOnActiveSpan(new Error("boom"));
    });
    span.end();

    const finished = exporter.getFinishedSpans();
    const recorded = finished[finished.length - 1];
    // SpanStatusCode.ERROR === 2
    expect(recorded.status.code).toBe(2);
    expect(recorded.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("is a safe no-op when no span is active", () => {
    expect(() =>
      recordExceptionOnActiveSpan(new Error("ignored")),
    ).not.toThrow();
  });

  it("coerces a non-Error value before recording", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("req2");
    context.with(trace.setSpan(context.active(), span), () => {
      recordExceptionOnActiveSpan("string failure");
    });
    span.end();
    const finished = exporter.getFinishedSpans();
    expect(finished[finished.length - 1].status.code).toBe(2);
  });
});

describe("initTracing", () => {
  it("is a no-op in none mode (no trace backend)", async () => {
    const { initTracing, shutdownTracing } = await import("./tracing.js");
    const config = loadConfig({ METRICS_EXPORTER: "none" });
    // Must not throw and must not require the Azure package.
    await expect(initTracing(config)).resolves.toBeUndefined();
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});
