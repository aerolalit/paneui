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
    expect(c.MAX_PARTICIPANTS_PER_PANE).toBe(32);
    // #308 — 6-month / 1-year retention defaults.
    expect(c.DEFAULT_TTL_SECONDS).toBe(15_768_000);
    expect(c.MAX_TTL_SECONDS).toBe(31_536_000);
    expect(c.HARD_RETENTION_DAYS_FREE).toBe(30);
    expect(c.HARD_RETENTION_DAYS_PAID).toBeNull();
    expect(c.HARD_DELETE_SWEEP_SECONDS).toBe(3600);
    expect(c.TTL_SWEEP_SECONDS).toBe(60);
    expect(c.REGISTER_RATE_LIMIT).toBe(5);
    expect(c.REGISTER_RATE_WINDOW_SECONDS).toBe(3600);
    expect(c.RATE_LIMIT).toBe(120);
    expect(c.RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(c.TRUSTED_PROXY).toEqual([]);
    expect(c.MAX_WS_CONNECTIONS_PER_PANE).toBe(16);
    expect(c.MAX_PANES_PER_AGENT).toBe(50);
    expect(c.MAX_EVENTS_PER_PANE).toBe(10_000);
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
      MAX_WS_CONNECTIONS_PER_PANE: "0",
      MAX_PANES_PER_AGENT: "0",
      MAX_EVENTS_PER_PANE: "0",
    });
    expect(c.RATE_LIMIT).toBe(0);
    expect(c.RATE_LIMIT_WINDOW_SECONDS).toBe(30);
    expect(c.MAX_WS_CONNECTIONS_PER_PANE).toBe(0);
    expect(c.MAX_PANES_PER_AGENT).toBe(0);
    expect(c.MAX_EVENTS_PER_PANE).toBe(0);
  });

  it("redacts creds in DATABASE_URL", () => {
    const c = loadConfig({ DATABASE_URL: "postgresql://user:pass@host/db" });
    const r = redactConfig(c);
    expect(r.DATABASE_URL).toBe("postgresql://<redacted>@host/db");
  });

  it("redacts the access key in REDIS_URL (Azure Cache for Redis shape)", () => {
    // Azure Cache for Redis hands out rediss://:<base64-key>@host:6380 —
    // the entire access key sits in the password slot of the userinfo.
    // (Test key below is a synthetic placeholder shaped like a real one.)
    const c = loadConfig({
      REDIS_URL: `rediss://:${"x".repeat(43)}=@example-cache.redis.cache.windows.net:6380`,
    });
    const r = redactConfig(c);
    expect(r.REDIS_URL).toBe(
      "rediss://<redacted>@example-cache.redis.cache.windows.net:6380",
    );
  });

  it("leaves REDIS_URL untouched when no userinfo is present", () => {
    // Self-host pattern: redis://localhost:6379 with no auth.
    const c = loadConfig({ REDIS_URL: "redis://localhost:6379" });
    const r = redactConfig(c);
    expect(r.REDIS_URL).toBe("redis://localhost:6379");
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

  // ---- EMAIL_PROVIDER=azure: ACS connection-string vs managed-identity ----

  it("fails fast when EMAIL_PROVIDER=azure has neither endpoint nor connection string", () => {
    expect(() =>
      loadConfig({ EMAIL_PROVIDER: "azure", EMAIL_FROM: "x@example.com" }),
    ).toThrow(/AZURE_COMMUNICATION_ENDPOINT_URL/);
  });

  it("accepts EMAIL_PROVIDER=azure with just the managed-identity endpoint URL (no secret)", () => {
    const c = loadConfig({
      EMAIL_PROVIDER: "azure",
      EMAIL_FROM: "x@example.com",
      AZURE_COMMUNICATION_ENDPOINT_URL:
        "https://acs-eur-prod-pane.europe.communication.azure.com",
    });
    expect(c.EMAIL_PROVIDER).toBe("azure");
    expect(c.AZURE_COMMUNICATION_ENDPOINT_URL).toMatch(/communication.azure/);
    expect(c.AZURE_COMMUNICATION_CONNECTION_STRING).toBeUndefined();
  });

  it("accepts EMAIL_PROVIDER=azure with just a connection string (no endpoint URL)", () => {
    const c = loadConfig({
      EMAIL_PROVIDER: "azure",
      EMAIL_FROM: "x@example.com",
      AZURE_COMMUNICATION_CONNECTION_STRING:
        "endpoint=https://x.communication.azure.com/;accesskey=AAAA",
    });
    expect(c.EMAIL_PROVIDER).toBe("azure");
    expect(c.AZURE_COMMUNICATION_CONNECTION_STRING).toContain("endpoint=");
  });

  it("rejects an AZURE_COMMUNICATION_ENDPOINT_URL that is not a valid URL", () => {
    expect(() =>
      loadConfig({
        EMAIL_PROVIDER: "azure",
        EMAIL_FROM: "x@example.com",
        AZURE_COMMUNICATION_ENDPOINT_URL: "not-a-url",
      }),
    ).toThrow();
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

describe("records env vars (#293)", () => {
  it("sets sane defaults for the records knobs", () => {
    const c = loadConfig({});
    expect(c.MAX_RECORDS_PER_COLLECTION).toBe(50_000);
    expect(c.MAX_RECORD_DATA_BYTES).toBe(65_536);
    expect(c.MAX_RECORDS_PER_PAGE).toBe(200);
    expect(c.RECORD_TOMBSTONE_TTL_SECONDS).toBe(604_800);
    expect(c.RECORD_SWEEPER_INTERVAL_SECONDS).toBe(3_600);
  });

  it("accepts overrides", () => {
    const c = loadConfig({
      MAX_RECORDS_PER_COLLECTION: "100",
      MAX_RECORD_DATA_BYTES: "8192",
      MAX_RECORDS_PER_PAGE: "50",
      RECORD_TOMBSTONE_TTL_SECONDS: "60",
      RECORD_SWEEPER_INTERVAL_SECONDS: "0", // disabled
    });
    expect(c.MAX_RECORDS_PER_COLLECTION).toBe(100);
    expect(c.MAX_RECORD_DATA_BYTES).toBe(8192);
    expect(c.MAX_RECORDS_PER_PAGE).toBe(50);
    expect(c.RECORD_TOMBSTONE_TTL_SECONDS).toBe(60);
    expect(c.RECORD_SWEEPER_INTERVAL_SECONDS).toBe(0);
  });

  it("allows MAX_RECORDS_PER_COLLECTION=0 to disable the cap", () => {
    const c = loadConfig({ MAX_RECORDS_PER_COLLECTION: "0" });
    expect(c.MAX_RECORDS_PER_COLLECTION).toBe(0);
  });

  it("rejects negative MAX_RECORDS_PER_COLLECTION", () => {
    expect(() => loadConfig({ MAX_RECORDS_PER_COLLECTION: "-1" })).toThrow();
  });

  it("rejects RECORD_TOMBSTONE_TTL_SECONDS < 60 (the floor)", () => {
    expect(() => loadConfig({ RECORD_TOMBSTONE_TTL_SECONDS: "10" })).toThrow();
  });

  it("rejects zero / negative MAX_RECORD_DATA_BYTES", () => {
    expect(() => loadConfig({ MAX_RECORD_DATA_BYTES: "0" })).toThrow();
    expect(() => loadConfig({ MAX_RECORD_DATA_BYTES: "-1" })).toThrow();
  });
});
