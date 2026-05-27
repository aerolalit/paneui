// EMAIL_PROVIDER=smtp — generic SMTP via nodemailer.
//
// Works with any SMTP server: Gmail (app password), Mailgun, Postmark, SES,
// Office 365, a self-hosted Postfix, etc. Dynamic import so the nodemailer
// dependency is only pulled in when this provider is selected.

import type { EmailProvider } from "../email-provider.js";

interface SmtpEmailOpts {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export async function makeSmtpProvider(
  opts: SmtpEmailOpts,
): Promise<EmailProvider> {
  let nodemailer: {
    createTransport(o: unknown): {
      sendMail(o: unknown): Promise<{ messageId: string }>;
    };
  };
  try {
    // No @types/nodemailer in tree; treat the import as `unknown` and project
    // onto our local typed interface.
    // @ts-expect-error — nodemailer is an optional dep with no bundled types
    const mod = await import("nodemailer");
    nodemailer = (mod.default ?? mod) as typeof nodemailer;
  } catch {
    throw new Error(
      "EMAIL_PROVIDER=smtp requires the nodemailer npm package — run " +
        "`npm install nodemailer` or pick a different provider.",
    );
  }
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: opts.user ? { user: opts.user, pass: opts.pass ?? "" } : undefined,
  });

  return {
    kind: "smtp",
    available: true,
    async sendMagicLink({ to, link, ttlSeconds }) {
      const ttlMinutes = Math.round(ttlSeconds / 60);
      const subject = `Sign in to pane — link expires in ${ttlMinutes} min`;
      const text = [
        "Sign in to pane",
        "",
        link,
        "",
        `This link expires in ${ttlMinutes} minutes and can be used once.`,
        "If you did not request this, you can safely ignore this email.",
      ].join("\n");
      await transport.sendMail({
        from: opts.from,
        to,
        subject,
        text,
      });
    },
  };
}
