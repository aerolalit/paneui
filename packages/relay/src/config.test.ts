import { describe, it, expect } from "vitest";
import { loadConfig, redactConfig } from "./config.js";

describe("config", () => {
  it("accepts an empty env and applies defaults", () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(3000);
    expect(c.MAX_ARTIFACT_BYTES).toBe(2_000_000);
    expect(c.MAX_EVENT_DATA_BYTES).toBe(65_536);
    expect(c.MAX_PARTICIPANTS_PER_SESSION).toBe(32);
    expect(c.DEFAULT_TTL_SECONDS).toBe(3600);
    expect(c.MAX_TTL_SECONDS).toBe(86_400);
    expect(c.TTL_SWEEP_SECONDS).toBe(60);
    expect(c.REGISTER_RATE_LIMIT).toBe(5);
    expect(c.REGISTER_RATE_WINDOW_SECONDS).toBe(3600);
    expect(c.LOG_LEVEL).toBe("info");
    expect(c.DATABASE_URL).toBe("file:./data/pane.db");
    expect(c.publicUrl).toBe("http://localhost:3000");
  });

  it("rejects a malformed PORT", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow();
  });

  it("rejects a PORT out of range", () => {
    expect(() => loadConfig({ PORT: "999999" })).toThrow();
  });

  it("rejects an invalid LOG_LEVEL", () => {
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow();
  });

  it("builds publicUrl from PUBLIC_URL if set, stripping trailing slash", () => {
    const c = loadConfig({ PUBLIC_URL: "https://pane.example.com/" });
    expect(c.publicUrl).toBe("https://pane.example.com");
  });

  it("redacts API_KEY", () => {
    const c = loadConfig({ API_KEY: "secret-key" });
    const r = redactConfig(c);
    expect(r.API_KEY).toBe("<set>");
  });

  it("coerces register rate-limit overrides; 0 disables", () => {
    const c = loadConfig({ REGISTER_RATE_LIMIT: "0", REGISTER_RATE_WINDOW_SECONDS: "60" });
    expect(c.REGISTER_RATE_LIMIT).toBe(0);
    expect(c.REGISTER_RATE_WINDOW_SECONDS).toBe(60);
  });

  it("redacts creds in DATABASE_URL", () => {
    const c = loadConfig({ DATABASE_URL: "postgresql://user:pass@host/db" });
    const r = redactConfig(c);
    expect(r.DATABASE_URL).toBe("postgresql://<redacted>@host/db");
  });
});
