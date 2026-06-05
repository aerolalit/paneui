import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { errors } from "./errors.js";

// Reject URLs whose host resolves to loopback / private / link-local / CGNAT /
// multicast / unspecified addresses, or whose protocol isn't http(s).
// Defends server-side outbound calls (webhook delivery) from being weaponised
// against the metadata service, local Redis, internal admin endpoints, etc.

function isBlockedIPv4(addr: string): boolean {
  const parts = addr.split(".").map((n) => Number(n));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return true; // malformed -> treat as blocked
  }
  const [a, b] = parts as [number, number, number, number];
  // 0.0.0.0/8 unspecified
  if (a === 0) return true;
  // 10.0.0.0/8 private
  if (a === 10) return true;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 private
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 reserved (incl. 255.255.255.255 broadcast)
  if (a >= 240) return true;
  return false;
}

function isBlockedIPv6(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === "::" || a === "::1") return true;
  // link-local fe80::/10
  if (
    a.startsWith("fe8") ||
    a.startsWith("fe9") ||
    a.startsWith("fea") ||
    a.startsWith("feb")
  )
    return true;
  // unique local fc00::/7
  if (a.startsWith("fc") || a.startsWith("fd")) return true;
  // multicast ff00::/8
  if (a.startsWith("ff")) return true;
  // IPv4-mapped ::ffff:x.x.x.x — fall through to v4 check
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isBlockedIPv4(mapped[1]!);
  return false;
}

/**
 * True iff `address` (an IP literal of the given DNS family, 4 or 6) is a
 * routable, non-blocked address — i.e. safe to connect to for an outbound
 * webhook. This is the single predicate behind both the create-time URL check
 * and the fire-time pin-and-connect: callers resolve a host, then keep only the
 * addresses for which this returns true. Anything malformed is treated as
 * blocked (returns false) by the underlying isBlocked* helpers.
 */
export function isSafeAddress(address: string, family: number): boolean {
  return family === 4 ? !isBlockedIPv4(address) : !isBlockedIPv6(address);
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  // metadata-style hostnames some clouds expose; cheap defence-in-depth.
  if (h === "metadata.google.internal") return true;
  if (h.endsWith(".local")) return true;
  if (h.endsWith(".internal")) return true;
  return false;
}

export interface AssertSafeUrlOptions {
  /** Field name used in error messages (e.g. "callback.url", "template.source"). */
  field?: string;
}

// DNS-rebinding posture (F-14 + follow-up).
//
// Create-time (routes/panes.ts) gates the URL via assertSafeOutboundUrl. That
// alone is racy: an attacker who controls DNS can resolve to a public IP at
// create time and rebind to a private IP before the webhook fires. The webhook
// send path (webhook.ts) now resolves the host ITSELF via resolveSafeOutboundUrl
// at fire time, verifies every resolved address, and PINS the connection to the
// returned safe IP — it dials that exact IP rather than re-resolving the
// hostname inside the HTTP client. That eliminates the second-resolution TOCTOU
// the previous re-validate-then-fetch approach left open (fetch/undici re-
// resolved DNS independently of the check). The original hostname is still used
// for the Host header and TLS SNI so certificate validation holds.
//
/**
 * A host that has been resolved AND verified safe, carrying the single IP the
 * caller should PIN the connection to. `host` is the original hostname (used
 * for the Host header and TLS SNI/servername so certificate validation still
 * works); `address`/`family` is the pre-validated IP to dial. `wasLiteral` is
 * true when the URL host was already an IP literal (no DNS was performed).
 */
export interface ResolvedSafeHost {
  url: URL;
  host: string;
  address: string;
  family: number;
  wasLiteral: boolean;
}

/**
 * Parse + validate `rawUrl` (protocol, no credentials, allowed hostname),
 * resolve its host, verify EVERY resolved address is safe, and return ONE safe
 * address to pin the outbound connection to. Throws the same invalidRequest
 * errors as before on any failure.
 *
 * Returning a pinned address (rather than just asserting) is what closes the
 * fire-time DNS-rebinding TOCTOU: the caller connects to this exact IP instead
 * of re-resolving the hostname (which the kernel/undici would otherwise do
 * inside fetch, racing the check). If ANY resolved address is unsafe we reject
 * the whole host — a rebind that mixes a public and a private answer must not
 * be allowed to slip the private one through.
 */
export async function resolveSafeOutboundUrl(
  rawUrl: string,
  opts: AssertSafeUrlOptions = {},
): Promise<ResolvedSafeHost> {
  const field = opts.field ?? "url";
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw errors.invalidRequest(`${field} must be a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw errors.invalidRequest(`${field} must use http or https`);
  }
  if (u.username || u.password) {
    throw errors.invalidRequest(`${field} must not contain credentials`);
  }
  // URL.hostname wraps IPv6 literals in brackets — strip for isIP/lookup.
  const host =
    u.hostname.startsWith("[") && u.hostname.endsWith("]")
      ? u.hostname.slice(1, -1)
      : u.hostname;
  if (!host) {
    throw errors.invalidRequest(`${field} must have a host`);
  }
  if (isBlockedHostname(host)) {
    throw errors.invalidRequest(`${field} host is not allowed`);
  }

  // If the host is already an IP literal, check it directly — pin to itself.
  const ipFamily = isIP(host);
  if (ipFamily === 4 || ipFamily === 6) {
    if (!isSafeAddress(host, ipFamily)) {
      throw errors.invalidRequest(
        `${field} resolves to a non-routable address`,
      );
    }
    return { url: u, host, address: host, family: ipFamily, wasLiteral: true };
  }

  // DNS lookup — check ALL resolved addresses (DNS rebinding defence).
  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw errors.invalidRequest(`${field} host could not be resolved`);
  }
  if (resolved.length === 0) {
    throw errors.invalidRequest(`${field} host could not be resolved`);
  }
  for (const r of resolved) {
    if (!isSafeAddress(r.address, r.family)) {
      throw errors.invalidRequest(
        `${field} resolves to a non-routable address`,
      );
    }
  }
  // All addresses safe — pin to the first (prefer IPv4 if present, mirroring
  // typical happy-eyeballs ordering and keeping literals predictable in tests).
  const first = resolved[0]!;
  return {
    url: u,
    host,
    address: first.address,
    family: first.family,
    wasLiteral: false,
  };
}

/**
 * Assert-only wrapper around {@link resolveSafeOutboundUrl}: validates the URL
 * is safe and discards the pinned address. Kept for callers that only gate
 * (e.g. create-time URL acceptance in routes/panes.ts) and do not themselves
 * dial the host.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  opts: AssertSafeUrlOptions = {},
): Promise<void> {
  await resolveSafeOutboundUrl(rawUrl, opts);
}

// Convenience aliases — keep callers readable at the use site.
export const assertSafeWebhookUrl = (url: string): Promise<void> =>
  assertSafeOutboundUrl(url, { field: "callback.url" });
// Resolve-and-pin variant for the actual webhook send: returns the safe IP to
// dial so webhook.ts connects to a pinned address (no second, unchecked DNS
// resolution inside the HTTP client). See resolveSafeOutboundUrl.
export const resolveSafeWebhookUrl = (url: string): Promise<ResolvedSafeHost> =>
  resolveSafeOutboundUrl(url, { field: "callback.url" });
export const assertSafeArtifactUrl = (url: string): Promise<void> =>
  assertSafeOutboundUrl(url, { field: "template.source" });
export const assertSafeBlobScanHookUrl = (url: string): Promise<void> =>
  assertSafeOutboundUrl(url, { field: "BLOB_SCAN_HOOK" });
