import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runBootstrap } from "./bootstrap.js";
import type { Config } from "./config.js";

const baseConfig: Config = {
  DATABASE_URL: "file:./test.db",
  PORT: 3000,
  PUBLIC_URL: undefined,
  API_KEY: undefined,
  REGISTRATION_SECRET: undefined,
  MAX_ARTIFACT_BYTES: 2_000_000,
  MAX_EVENT_DATA_BYTES: 65_536,
  MAX_PARTICIPANTS_PER_SESSION: 32,
  DEFAULT_TTL_SECONDS: 3600,
  MAX_TTL_SECONDS: 86_400,
  TTL_SWEEP_SECONDS: 60,
  LOG_LEVEL: "error",
  publicUrl: "http://localhost:3000",
};

function makeMockPrisma(initialCount = 0) {
  const upsertSpy = vi.fn(async (args: { create: { name: string; keyHash: string; keyPrefix: string } }) => ({
    id: "agent_mock",
    ...args.create,
  }));
  const createSpy = vi.fn(async (args: { data: { name: string; keyHash: string; keyPrefix: string } }) => ({
    id: "agent_mock",
    ...args.data,
  }));
  const countSpy = vi.fn(async () => initialCount);
  const prisma = {
    agent: { upsert: upsertSpy, create: createSpy, count: countSpy },
  } as unknown as PrismaClient;
  return { prisma, upsertSpy, createSpy, countSpy };
}

describe("bootstrap", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuffer: string;

  beforeEach(() => {
    stdoutBuffer = "";
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdoutBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("upserts a default agent when API_KEY is set", async () => {
    const { prisma, upsertSpy, createSpy, countSpy } = makeMockPrisma();
    const config: Config = { ...baseConfig, API_KEY: "pane_test1234567890abcdef1234567890ab" };

    await runBootstrap(prisma, config);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
    expect(countSpy).not.toHaveBeenCalled();

    const args = upsertSpy.mock.calls[0]![0];
    expect(args.create.name).toBe("default");
    expect(args.create.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.create.keyPrefix).toBe("pane_test12");
    expect(stdoutBuffer).not.toContain("Generated one:");
  });

  it("auto-mints + prints a banner when no API_KEY and DB is empty", async () => {
    const { prisma, upsertSpy, createSpy, countSpy } = makeMockPrisma(0);

    await runBootstrap(prisma, baseConfig);

    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).not.toHaveBeenCalled();

    expect(stdoutBuffer).toContain("No API_KEY set and no agents existed");
    expect(stdoutBuffer).toMatch(/Generated one: pane_[0-9a-f]{32}/);
    expect(stdoutBuffer).toContain("SAVE IT NOW");

    const args = createSpy.mock.calls[0]![0];
    expect(args.data.name).toBe("default");
    expect(args.data.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does nothing when no API_KEY but agents already exist", async () => {
    const { prisma, upsertSpy, createSpy, countSpy } = makeMockPrisma(1);

    await runBootstrap(prisma, baseConfig);

    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(stdoutBuffer).not.toContain("Generated one:");
  });

  it("is idempotent: repeated calls with the same API_KEY use the same keyHash", async () => {
    const { prisma, upsertSpy } = makeMockPrisma();
    const config: Config = { ...baseConfig, API_KEY: "pane_test1234567890abcdef1234567890ab" };

    await runBootstrap(prisma, config);
    await runBootstrap(prisma, config);

    expect(upsertSpy).toHaveBeenCalledTimes(2);
    const hash1 = upsertSpy.mock.calls[0]![0].create.keyHash;
    const hash2 = upsertSpy.mock.calls[1]![0].create.keyHash;
    expect(hash1).toBe(hash2);
    // The where clause keys on the same hash, so a real Prisma upsert would no-op the second call.
    const where1 = (upsertSpy.mock.calls[0]![0] as unknown as { where: { keyHash: string } }).where;
    expect(where1.keyHash).toBe(hash1);
  });
});
