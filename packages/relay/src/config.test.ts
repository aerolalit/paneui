import { describe, it, expect } from "vitest";
import {
  ConfigError,
  loadConfig,
  redactConfig,
  validateProductionConfig,
} from "./config.js";

describe("config", () => {
  it("accepts an empty env and applies defaults", () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(3000);
    expect(c.MAX_ARTIFACT_BYTES).toBe(2_000_000);
    expect(c.MAX_EVENT_DATA_BYTES).toBe(65_536);
    expect(c.MAX_PARTICIPANTS_PER_SESSION).toBe(32);
    expect(c.DEFAULT_TTL_SECONDS).toBe(900);
    expect(c.MAX_TTL_SECONDS).toBe(86_400);
    expect(c.TTL_SWEEP_SECONDS).toBe(60);
    expect(c.REGISTER_RATE_LIMIT).toBe(5);
    expect(c.REGISTER_RATE_WINDOW_SECONDS).toBe(3600);
    expect(c.RATE_LIMIT).toBe(120);
    expect(c.RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(c.TRUSTED_PROXY).toEqual([]);
    expect(c.MAX_WS_CONNECTIONS_PER_SESSION).toBe(16);
    expect(c.MAX_SESSIONS_PER_AGENT).toBe(50);
    expect(c.MAX_EVENTS_PER_SESSION).toBe(10_000);
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
    const c = loadConfig({
      REGISTER_RATE_LIMIT: "0",
      REGISTER_RATE_WINDOW_SECONDS: "60",
    });
    expect(c.REGISTER_RATE_LIMIT).toBe(0);
    expect(c.REGISTER_RATE_WINDOW_SECONDS).toBe(60);
  });

  it("parses TRUSTED_PROXY into a trimmed, non-empty list", () => {
    const c = loadConfig({ TRUSTED_PROXY: " 10.0.0.1 , 10.0.0.2 ,," });
    expect(c.TRUSTED_PROXY).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("coerces general rate-limit + abuse-cap overrides; 0 disables", () => {
    const c = loadConfig({
      RATE_LIMIT: "0",
      RATE_LIMIT_WINDOW_SECONDS: "30",
      MAX_WS_CONNECTIONS_PER_SESSION: "0",
      MAX_SESSIONS_PER_AGENT: "0",
      MAX_EVENTS_PER_SESSION: "0",
    });
    expect(c.RATE_LIMIT).toBe(0);
    expect(c.RATE_LIMIT_WINDOW_SECONDS).toBe(30);
    expect(c.MAX_WS_CONNECTIONS_PER_SESSION).toBe(0);
    expect(c.MAX_SESSIONS_PER_AGENT).toBe(0);
    expect(c.MAX_EVENTS_PER_SESSION).toBe(0);
  });

  it("redacts creds in DATABASE_URL", () => {
    const c = loadConfig({ DATABASE_URL: "postgresql://user:pass@host/db" });
    const r = redactConfig(c);
    expect(r.DATABASE_URL).toBe("postgresql://<redacted>@host/db");
  });

  it("defaults METRICS_EXPORTER to none", () => {
    expect(loadConfig({}).METRICS_EXPORTER).toBe("none");
  });

  it("accepts METRICS_EXPORTER=azure explicitly", () => {
    expect(
      loadConfig({
        METRICS_EXPORTER: "azure",
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=test",
      }).METRICS_EXPORTER,
    ).toBe("azure");
  });

  it("rejects an unknown METRICS_EXPORTER", () => {
    expect(() => loadConfig({ METRICS_EXPORTER: "datadog" })).toThrow();
  });

  it("rejects METRICS_EXPORTER=prometheus (no longer supported)", () => {
    expect(() => loadConfig({ METRICS_EXPORTER: "prometheus" })).toThrow();
  });

  it("fails fast when METRICS_EXPORTER=azure has no connection string", () => {
    expect(() => loadConfig({ METRICS_EXPORTER: "azure" })).toThrow(
      /APPLICATIONINSIGHTS_CONNECTION_STRING/,
    );
  });

  it("accepts METRICS_EXPORTER=azure with a connection string", () => {
    const c = loadConfig({
      METRICS_EXPORTER: "azure",
      APPLICATIONINSIGHTS_CONNECTION_STRING:
        "InstrumentationKey=00000000-0000-0000-0000-000000000000",
    });
    expect(c.METRICS_EXPORTER).toBe("azure");
    expect(c.APPLICATIONINSIGHTS_CONNECTION_STRING).toContain(
      "InstrumentationKey=",
    );
  });

  it("does not require a connection string when azure is disabled via METRICS_ENABLED=false", () => {
    const c = loadConfig({
      METRICS_EXPORTER: "azure",
      METRICS_ENABLED: "false",
    });
    expect(c.METRICS_ENABLED).toBe(false);
  });

  it("redacts APPLICATIONINSIGHTS_CONNECTION_STRING", () => {
    const c = loadConfig({
      METRICS_EXPORTER: "azure",
      APPLICATIONINSIGHTS_CONNECTION_STRING:
        "InstrumentationKey=00000000-0000-0000-0000-000000000000",
    });
    expect(redactConfig(c).APPLICATIONINSIGHTS_CONNECTION_STRING).toBe("<set>");
  });

  it("redacts a password-bearing query param in DATABASE_URL", () => {
    const c = loadConfig({
      DATABASE_URL: "postgresql://host/db?sslmode=require&password=s3cret",
    });
    const r = redactConfig(c);
    expect(r.DATABASE_URL).toBe(
      "postgresql://host/db?sslmode=require&password=<redacted>",
    );
  });

  it("redacts both inline userinfo and a password query param", () => {
    const c = loadConfig({
      DATABASE_URL: "postgresql://user:pass@host/db?pwd=other",
    });
    const r = redactConfig(c);
    expect(r.DATABASE_URL).toBe(
      "postgresql://<redacted>@host/db?pwd=<redacted>",
    );
  });

  it("throws a ConfigError with a friendly message on a bad PORT", () => {
    let err: unknown;
    try {
      loadConfig({ PORT: "999999" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain(
      "invalid relay configuration",
    );
    expect((err as ConfigError).message).toContain("PORT");
  });

  it("lists every invalid field in the ConfigError message", () => {
    let err: unknown;
    try {
      loadConfig({ PORT: "not-a-port", LOG_LEVEL: "verbose" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).message;
    expect(msg).toContain("PORT");
    expect(msg).toContain("LOG_LEVEL");
  });

  it("defaults NODE_ENV to development and isProduction to false", () => {
    const c = loadConfig({});
    expect(c.NODE_ENV).toBe("development");
    expect(c.isProduction).toBe(false);
  });

  it("sets isProduction when NODE_ENV=production", () => {
    const c = loadConfig({
      NODE_ENV: "production",
      PUBLIC_URL: "https://pane.example.com",
    });
    expect(c.isProduction).toBe(true);
  });
});

describe("validateProductionConfig", () => {
  it("is a no-op outside production", () => {
    const c = loadConfig({}); // localhost publicUrl, dev
    expect(() => validateProductionConfig(c)).not.toThrow();
  });

  it("throws in production when PUBLIC_URL is unset", () => {
    const c = loadConfig({ NODE_ENV: "production" });
    expect(() => validateProductionConfig(c)).toThrow(/PUBLIC_URL must be set/);
  });

  it("throws in production when PUBLIC_URL points at localhost", () => {
    const c = loadConfig({
      NODE_ENV: "production",
      PUBLIC_URL: "http://localhost:3000",
    });
    expect(() => validateProductionConfig(c)).toThrow(/localhost/);
  });

  it("throws in production when PUBLIC_URL points at 127.0.0.1", () => {
    const c = loadConfig({
      NODE_ENV: "production",
      PUBLIC_URL: "http://127.0.0.1:3000",
    });
    expect(() => validateProductionConfig(c)).toThrow(/localhost/);
  });

  it("accepts a real https PUBLIC_URL in production", () => {
    const c = loadConfig({
      NODE_ENV: "production",
      PUBLIC_URL: "https://pane.example.com",
    });
    expect(() => validateProductionConfig(c)).not.toThrow();
  });
});
