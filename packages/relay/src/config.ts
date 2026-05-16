import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("file:./data/pane.db"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.string().url().optional(),
  API_KEY: z.string().optional(),
  PANE_SECRET_KEY: z.string().optional(),
  // Per-IP rate limit for the open POST /v1/register endpoint.
  // REGISTER_RATE_LIMIT=0 disables the limiter entirely (unlimited).
  REGISTER_RATE_LIMIT: z.coerce.number().int().min(0).default(5),
  REGISTER_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_ARTIFACT_BYTES: z.coerce.number().int().positive().default(2_000_000),
  MAX_EVENT_DATA_BYTES: z.coerce.number().int().positive().default(65_536),
  MAX_PARTICIPANTS_PER_SESSION: z.coerce.number().int().positive().default(32),
  DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  TTL_SWEEP_SECONDS: z.coerce.number().int().min(0).default(60),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends RawConfig {
  publicUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const parsed = schema.parse(env);
  const publicUrl = (parsed.PUBLIC_URL ?? `http://localhost:${parsed.PORT}`).replace(/\/$/, "");
  return Object.freeze({ ...parsed, publicUrl }) as Config;
}

export function redactConfig(c: Config): Record<string, unknown> {
  const r: Record<string, unknown> = { ...c };
  if (r.API_KEY) r.API_KEY = "<set>";
  if (r.PANE_SECRET_KEY) r.PANE_SECRET_KEY = "<set>";
  if (typeof r.DATABASE_URL === "string") {
    r.DATABASE_URL = r.DATABASE_URL.replace(/:\/\/([^@/]+)@/, "://<redacted>@");
  }
  return r;
}

const config = loadConfig();
export default config;
