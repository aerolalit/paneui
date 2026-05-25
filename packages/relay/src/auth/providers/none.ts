// EMAIL_PROVIDER=none — the default. Human-side login is disabled.
// The auth routes return 503 auth_provider_unavailable so callers can
// detect the disabled state and (e.g.) hide the login UI.

import type { EmailProvider } from "../email-provider.js";

export function makeNoneProvider(): EmailProvider {
  return {
    kind: "none",
    available: false,
    async sendMagicLink() {
      throw new Error("email provider is `none` — human-side login disabled");
    },
  };
}
