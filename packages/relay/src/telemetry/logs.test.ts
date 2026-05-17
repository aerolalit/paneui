// Unit tests for the OTel logs bridge.
//
// The LoggerProvider is only built by initLogs() in azure mode (it needs the
// optional Azure exporter), so we do NOT exercise the full provider path here
// — that would require mocking the dynamic import and would be flaky. We
// verify the two pieces of logic the relay owns directly:
//   1. emitLogRecord() is a safe no-op when no LoggerProvider is installed
//      (i.e. always, outside azure mode) — it must never throw.
//   2. initLogs() is a no-op in non-azure modes (no provider, no exporter).
// The stdout-logging path (which must not regress) is covered by log.ts being
// exercised throughout the rest of the suite.

import { describe, it, expect } from "vitest";
import { emitLogRecord, initLogs, shutdownLogs } from "./logs.js";
import { loadConfig } from "../config.js";

describe("emitLogRecord", () => {
  it("is a safe no-op when no LoggerProvider is installed", () => {
    expect(() => emitLogRecord("info", "hello", { a: 1 })).not.toThrow();
    expect(() => emitLogRecord("error", "boom")).not.toThrow();
    expect(() => emitLogRecord("nonsense", "weird level")).not.toThrow();
  });
});

describe("initLogs", () => {
  it("is a no-op in prometheus mode (no log backend)", async () => {
    const config = loadConfig({ METRICS_EXPORTER: "prometheus" });
    await expect(initLogs(config)).resolves.toBeUndefined();
    await expect(shutdownLogs()).resolves.toBeUndefined();
  });

  it("is a no-op in none mode", async () => {
    const config = loadConfig({ METRICS_EXPORTER: "none" });
    await expect(initLogs(config)).resolves.toBeUndefined();
    await expect(shutdownLogs()).resolves.toBeUndefined();
  });
});
