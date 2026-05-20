import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import { generateApiKey, hashKey, keyPrefix } from "./keys.js";
import { log } from "./log.js";

/**
 * First-boot agent provisioning. Runs every boot but is idempotent.
 *
 * Decision matrix:
 *
 *   API_KEY  REGISTRATION_MODE   Action
 *   -------  ------------------  --------------------------------------------
 *   set      any                 upsert "default" agent against the key hash
 *                                (idempotent — same key in, same agent)
 *   unset    open                NO-OP — agents register themselves via
 *                                POST /v1/register; minting a bootstrap key
 *                                would be redundant and seed an unowned
 *                                "default" agent nobody asked for.
 *   unset    closed | secret     Mint a fresh key + create the default agent
 *                                (only when no agents exist yet). This is the
 *                                operator's one way in when self-registration
 *                                is gated.
 */
export async function runBootstrap(
  prisma: PrismaClient,
  config: Config,
): Promise<void> {
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

  // Open registration means agents self-provision via POST /v1/register.
  // Minting a bootstrap key here would create an unowned "default" agent and
  // print its key to stdout — both unwanted in this mode.
  if (config.REGISTRATION_MODE === "open") {
    log.info(
      "bootstrap: REGISTRATION_MODE=open — agents will self-register via " +
        "POST /v1/register; no bootstrap key minted",
    );
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
