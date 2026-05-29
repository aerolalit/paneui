// EMAIL_PROVIDER=azure — Azure Communication Services Email.
//
// Uses the `@azure/communication-email` SDK. Dynamic import so a self-host
// that doesn't pick this provider never pulls the SDK into its bundle.
//
// Two auth paths — pick whichever fits the deployment:
//
//   1. Managed identity (preferred when the relay runs on Azure):
//      pass `endpointUrl`. The SDK uses DefaultAzureCredential to fetch
//      a token at request time; no secret is stored anywhere. The
//      identity (Container App MI / VM MSI / az-CLI dev login) must
//      hold the "Communication and Email Service Owner" role on the
//      ACS resource.
//
//   2. Connection string (simpler for local testing or self-hosters
//      without an MI): pass `connectionString`. Authenticates via the
//      shared key embedded in the string.
//
// If both are provided the caller (factory.ts) chooses one; this module
// just constructs an EmailClient with whatever auth it was given.

import type { EmailProvider } from "../email-provider.js";

export type AzureEmailOpts =
  | { kind: "endpoint"; endpointUrl: string; from: string }
  | { kind: "connection-string"; connectionString: string; from: string };

// Structural type for the SDK's EmailClient — both overloads it exposes.
// We import the SDK dynamically (see below) and cast to this shape.
interface EmailClientCtor {
  // (connectionString)
  new (cs: string): EmailClientInstance;
  // (endpoint, credential)
  new (endpoint: string, credential: unknown): EmailClientInstance;
}
interface EmailClientInstance {
  beginSend(message: unknown): Promise<{
    pollUntilDone(): Promise<{
      status: string;
      error?: { code: string; message: string };
    }>;
  }>;
}

export async function makeAzureProvider(
  opts: AzureEmailOpts,
): Promise<EmailProvider> {
  // Dynamic import: the SDK isn't a hard dependency. Self-hosters who set
  // EMAIL_PROVIDER=azure must install `@azure/communication-email` themselves;
  // the hosted relay's image bundles it.
  let EmailClient: EmailClientCtor;
  try {
    const mod = await import("@azure/communication-email");
    EmailClient = mod.EmailClient as unknown as EmailClientCtor;
  } catch {
    throw new Error(
      "EMAIL_PROVIDER=azure requires the @azure/communication-email npm " +
        "package — run `npm install @azure/communication-email` or pick a " +
        "different provider.",
    );
  }

  let client: EmailClientInstance;
  if (opts.kind === "endpoint") {
    // Managed-identity path. @azure/identity is a peer of the storage SDK
    // already pulled in for blob auth; reuse it here so we don't add a
    // separate dependency just for ACS.
    let DefaultAzureCredential: new () => unknown;
    try {
      const mod = await import("@azure/identity");
      DefaultAzureCredential =
        mod.DefaultAzureCredential as unknown as new () => unknown;
    } catch {
      throw new Error(
        "AZURE_COMMUNICATION_ENDPOINT_URL is set but @azure/identity is not " +
          "installed — run `npm install @azure/identity`, set " +
          "AZURE_COMMUNICATION_CONNECTION_STRING instead, or pick a different " +
          "provider.",
      );
    }
    client = new EmailClient(opts.endpointUrl, new DefaultAzureCredential());
  } else {
    client = new EmailClient(opts.connectionString);
  }

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
