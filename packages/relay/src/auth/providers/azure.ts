// EMAIL_PROVIDER=azure — Azure Communication Services Email.
//
// Uses the `@azure/communication-email` SDK. Dynamic import so a self-host
// that doesn't pick this provider never pulls the SDK into its bundle.
//
// Configure with AZURE_COMMUNICATION_CONNECTION_STRING (from the Communication
// Services resource in the Azure portal) and EMAIL_FROM (a verified sender
// address in the same resource's domain configuration).

import type { EmailProvider } from "../email-provider.js";

interface AzureEmailOpts {
  connectionString: string;
  from: string;
}

export async function makeAzureProvider(
  opts: AzureEmailOpts,
): Promise<EmailProvider> {
  // Dynamic import: the SDK isn't a hard dependency. Self-hosters who set
  // EMAIL_PROVIDER=azure must install `@azure/communication-email` themselves;
  // the hosted relay's image bundles it.
  let EmailClient: {
    new (cs: string): {
      beginSend(message: unknown): Promise<{
        pollUntilDone(): Promise<{
          status: string;
          error?: { code: string; message: string };
        }>;
      }>;
    };
  };
  try {
    const mod = await import("@azure/communication-email");
    EmailClient = mod.EmailClient as unknown as typeof EmailClient;
  } catch {
    throw new Error(
      "EMAIL_PROVIDER=azure requires the @azure/communication-email npm " +
        "package — run `npm install @azure/communication-email` or pick a " +
        "different provider.",
    );
  }
  const client = new EmailClient(opts.connectionString);

  return {
    kind: "azure",
    available: true,
    async sendMagicLink({ to, link, ttlSeconds }) {
      const ttlMinutes = Math.round(ttlSeconds / 60);
      const subject = `Sign in to pane — link expires in ${ttlMinutes} min`;
      // Both text and HTML alternatives. Some mail clients render
      // text/plain only; HTML is the human-friendly version.
      const plain = [
        "Sign in to pane",
        "",
        link,
        "",
        `This link expires in ${ttlMinutes} minutes and can be used once.`,
        "If you did not request this, you can safely ignore this email.",
      ].join("\n");
      const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;margin:0 0 16px;">Sign in to pane</h1>
  <p>Click the link below to sign in:</p>
  <p style="margin:24px 0;">
    <a href="${escapeHtml(link)}" style="background:#1a1a1a;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600;">Sign in</a>
  </p>
  <p style="font-size:14px;color:#6b6b6b;">This link expires in ${ttlMinutes} minutes and can be used once. If you did not request this, you can safely ignore this email.</p>
</body></html>`;

      const poller = await client.beginSend({
        senderAddress: opts.from,
        content: { subject, plainText: plain, html },
        recipients: { to: [{ address: to }] },
      });
      const result = await poller.pollUntilDone();
      if (result.status !== "Succeeded") {
        throw new Error(
          `azure email send failed: ${result.error?.code ?? "unknown"} ${result.error?.message ?? ""}`.trim(),
        );
      }
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
