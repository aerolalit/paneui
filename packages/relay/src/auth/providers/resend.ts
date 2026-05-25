// EMAIL_PROVIDER=resend — Resend (resend.com).
//
// Resend's API is fetch-based; we use the native `fetch` rather than the
// `resend` npm package to keep the dependency footprint zero.

import type { EmailProvider } from "../email-provider.js";

interface ResendEmailOpts {
  apiKey: string;
  from: string;
}

export function makeResendProvider(opts: ResendEmailOpts): EmailProvider {
  return {
    kind: "resend",
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

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: opts.from,
          to,
          subject,
          text,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `resend email send failed: ${res.status} ${res.statusText} ${detail}`.trim(),
        );
      }
    },
  };
}
