// EmailProvider factory — selects the implementation from config.
//
// Returned at boot time and threaded through buildApp(). Routes use
// `provider.available` to decide between serving the auth flow and
// returning 503 auth_provider_unavailable.

import type { Config } from "../config.js";
import type { EmailProvider } from "./email-provider.js";
import { makeAzureProvider } from "./providers/azure.js";
import { makeDevProvider } from "./providers/dev.js";
import { makeNoneProvider } from "./providers/none.js";
import { makeResendProvider } from "./providers/resend.js";
import { makeSmtpProvider } from "./providers/smtp.js";

export async function makeEmailProvider(
  config: Config,
): Promise<EmailProvider> {
  switch (config.EMAIL_PROVIDER) {
    case "none":
      return makeNoneProvider();
    case "dev":
      return makeDevProvider({ isProduction: config.isProduction });
    case "azure":
      return makeAzureProvider({
        connectionString: config.AZURE_COMMUNICATION_CONNECTION_STRING!,
        from: config.EMAIL_FROM!,
      });
    case "smtp":
      return makeSmtpProvider({
        host: config.SMTP_HOST!,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
        from: config.EMAIL_FROM!,
      });
    case "resend":
      return makeResendProvider({
        apiKey: config.RESEND_API_KEY!,
        from: config.EMAIL_FROM!,
      });
  }
}
