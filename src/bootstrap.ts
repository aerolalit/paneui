import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import { generateApiKey, hashKey, keyPrefix } from "./keys.js";
import { log } from "./log.js";

export async function runBootstrap(prisma: PrismaClient, config: Config): Promise<void> {
  if (config.API_KEY) {
    const hash = hashKey(config.API_KEY);
    await prisma.agent.upsert({
      where: { keyHash: hash },
      create: {
        name: "default",
        keyHash: hash,
        keyPrefix: keyPrefix(config.API_KEY),
      },
      update: {},
    });
    log.info("bootstrap: ensured default agent from API_KEY");
    return;
  }

  const count = await prisma.agent.count();
  if (count === 0) {
    const key = generateApiKey();
    await prisma.agent.create({
      data: {
        name: "default",
        keyHash: hashKey(key),
        keyPrefix: keyPrefix(key),
      },
    });
    const banner = [
      "",
      "================================================================",
      "  No API_KEY set and no agents existed.",
      `  Generated one: ${key}`,
      "  SAVE IT NOW. It will not be shown again.",
      "================================================================",
      "",
    ].join("\n");
    process.stdout.write(banner);
    return;
  }

  log.info("bootstrap: agents already exist, nothing to do", { count });
}
