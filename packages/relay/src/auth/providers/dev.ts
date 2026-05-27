// EMAIL_PROVIDER=dev — prints the magic link to the relay's logs instead of
// sending an email. The only provider that needs no external dependency or
// configuration. For local dev only; production starts the relay with an
// `available=false` warning in the boot log if this provider is selected.

import { log } from "../../log.js";
import type { EmailProvider } from "../email-provider.js";

export function makeDevProvider(opts: {
  isProduction: boolean;
}): EmailProvider {
  if (opts.isProduction) {
    log.warn(
      "EMAIL_PROVIDER=dev in production — magic links will be printed to logs, never emailed",
    );
  }
  return {
    kind: "dev",
    available: true,
    async sendMagicLink({ to, link, ttlSeconds }) {
      // Multi-line, easy to spot in log output. The link is the secret; the
      // dev human reads it from `docker logs` / `kubectl logs` / etc.
      log.info("magic link (dev provider)", { to, link, ttlSeconds });
    },
  };
}
