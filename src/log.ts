import config from "./config.js";

type Level = "debug" | "info" | "warn" | "error";

const levels: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = levels[config.LOG_LEVEL];

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (levels[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit("info",  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit("warn",  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
