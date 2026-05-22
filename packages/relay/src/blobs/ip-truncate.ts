// Truncate a client IP to a /24 (IPv4) or /48 (IPv6) network range. The relay
// persists ONLY the truncated form in the BlobToken audit columns — full
// requester addresses are never written. This is enough to spot anomalies
// ("token first used from one ISP, suddenly used from another") without
// becoming a tracking database.
//
// Inputs come from req.header("x-forwarded-for") | the connection address.
// Garbage in (proxy header injected by an attacker, IPv6 with embedded IPv4,
// trailing port like `1.2.3.4:5678`) gets best-effort cleaned; on anything
// truly unparseable we return null and the caller skips the audit write
// rather than persist `null` masquerading as a real range.

/**
 * Best-effort: turn a raw "client IP" string into its /24 (IPv4) or /48
 * (IPv6) network range. Returns null if the input isn't a parseable address.
 */
export function truncateIp(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // X-Forwarded-For can be a comma list — first hop is the client.
  const first = raw.split(",")[0]!.trim();
  if (!first) return null;

  // Strip an IPv6 zone identifier (e.g. `fe80::1%en0`).
  const noZone = first.split("%")[0]!;

  // Strip `[…]:port` notation around an IPv6 literal.
  const bracketed = /^\[([^\]]+)\]/.exec(noZone);
  if (bracketed) {
    return truncateIpv6(bracketed[1]!);
  }

  // IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → treat as IPv4.
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(noZone);
  if (v4Mapped) return truncateIpv4(v4Mapped[1]!);

  // Plain IPv4 with optional trailing port.
  const v4 = /^(\d+\.\d+\.\d+\.\d+)(?::\d+)?$/.exec(noZone);
  if (v4) return truncateIpv4(v4[1]!);

  // Plain IPv6 (no brackets, no port).
  if (noZone.includes(":")) return truncateIpv6(noZone);

  return null;
}

function truncateIpv4(addr: string): string | null {
  const parts = addr.split(".").map((s) => Number(s));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return null;
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function truncateIpv6(addr: string): string | null {
  // Expand the address to its 8-group representation, then keep the first 3
  // groups (48 bits) and emit `<g1>:<g2>:<g3>::/48`.
  const groups = expandIpv6(addr);
  if (!groups) return null;
  return `${groups[0]}:${groups[1]}:${groups[2]}::/48`;
}

/**
 * Expand a shorthand IPv6 (e.g. `2001:db8::1`) into eight 4-char hex groups.
 * Returns null if the input isn't a valid IPv6 literal.
 */
function expandIpv6(addr: string): string[] | null {
  const hasDoubleColon = addr.includes("::");
  // `::` can only appear once.
  if ((addr.match(/::/g) ?? []).length > 1) return null;

  let head: string[];
  let tail: string[] = [];

  if (hasDoubleColon) {
    const [h, t] = addr.split("::");
    head = h ? h.split(":") : [];
    tail = t ? t.split(":") : [];
  } else {
    head = addr.split(":");
  }

  if (head.length + tail.length > 8) return null;
  for (const g of [...head, ...tail]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }

  const fill = new Array(8 - head.length - tail.length).fill("0");
  const all = [...head, ...fill, ...tail].map((g) =>
    g.padStart(4, "0").toLowerCase(),
  );
  return all;
}
