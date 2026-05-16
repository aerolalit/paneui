import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { errors } from "./errors.js";

// Reject URLs whose host resolves to loopback / private / link-local / CGNAT /
// multicast / unspecified addresses, or whose protocol isn't http(s).
// Defends server-side outbound calls (webhook delivery) from being weaponised
// against the metadata service, local Redis, internal admin endpoints, etc.

function isBlockedIPv4(addr: string): boolean {
  const parts = addr.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
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
  if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return true;
  // unique local fc00::/7
  if (a.startsWith("fc") || a.startsWith("fd")) return true;
  // multicast ff00::/8
  if (a.startsWith("ff")) return true;
  // IPv4-mapped ::ffff:x.x.x.x — fall through to v4 check
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isBlockedIPv4(mapped[1]!);
  return false;
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
  /** Field name used in error messages (e.g. "callback.url", "artifact.source"). */
  field?: string;
}

export async function assertSafeOutboundUrl(
  rawUrl: string,
  opts: AssertSafeUrlOptions = {},
): Promise<void> {
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
  const host = u.hostname.startsWith("[") && u.hostname.endsWith("]")
    ? u.hostname.slice(1, -1)
    : u.hostname;
  if (!host) {
    throw errors.invalidRequest(`${field} must have a host`);
  }
  if (isBlockedHostname(host)) {
    throw errors.invalidRequest(`${field} host is not allowed`);
  }

  // If the host is already an IP literal, check it directly.
  const ipFamily = isIP(host);
  if (ipFamily === 4) {
    if (isBlockedIPv4(host)) throw errors.invalidRequest(`${field} resolves to a non-routable address`);
    return;
  }
  if (ipFamily === 6) {
    if (isBlockedIPv6(host)) throw errors.invalidRequest(`${field} resolves to a non-routable address`);
    return;
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
    const blocked = r.family === 4 ? isBlockedIPv4(r.address) : isBlockedIPv6(r.address);
    if (blocked) {
      throw errors.invalidRequest(`${field} resolves to a non-routable address`);
    }
  }
}

// Convenience aliases — keep callers readable at the use site.
export const assertSafeWebhookUrl = (url: string): Promise<void> =>
  assertSafeOutboundUrl(url, { field: "callback.url" });
export const assertSafeArtifactUrl = (url: string): Promise<void> =>
  assertSafeOutboundUrl(url, { field: "artifact.source" });
