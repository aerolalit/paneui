// Email provider interface for the magic-link login flow (Phase B).
//
// The relay sends exactly one kind of transactional email: a magic-link
// login email. Implementations live under ./providers/ and are selected
// by EMAIL_PROVIDER. See docs/HUMAN-SIDE-PROPOSAL.md §4.3 — every provider
// except `none` and `dev` requires an EMAIL_FROM address + provider-specific
// config; `none` disables the flow entirely.

export interface EmailProvider {
  /** Human-readable provider name (for logs + error messages). */
  readonly kind: "none" | "dev" | "azure" | "smtp" | "resend";

  /** True if this provider is functional. `none` is false (login is disabled). */
  readonly available: boolean;

  /**
   * Send a magic-link login email to {@link to}. Implementations are
   * responsible for whatever rendering / signing the upstream service
   * requires. The relay has already minted the token, stored its hash,
   * and built {@link link} (an absolute URL containing the raw token).
   *
   * Rejects with a thrown Error on failure. The route layer catches and
   * returns a 502 with a `provider_error` envelope.
   */
  sendMagicLink(args: {
    to: string;
    link: string;
    /** TTL in seconds — used to render "expires in N min" in the email. */
    ttlSeconds: number;
  }): Promise<void>;
}
