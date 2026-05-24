// Unit tests for the IP truncation helper. The relay persists ONLY the
// /24 (IPv4) or /48 (IPv6) network range in AttachmentToken audit columns — these
// tests pin the exact shape of those truncated values and the rejection of
// unparseable inputs.

import { describe, it, expect } from "vitest";
import { truncateIp } from "./ip-truncate.js";

describe("truncateIp — IPv4", () => {
  it("truncates a normal IPv4 to /24", () => {
    expect(truncateIp("192.168.1.42")).toBe("192.168.1.0/24");
    expect(truncateIp("203.0.113.7")).toBe("203.0.113.0/24");
  });

  it("strips an embedded port", () => {
    expect(truncateIp("192.168.1.42:5678")).toBe("192.168.1.0/24");
  });

  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(truncateIp("::ffff:192.168.1.42")).toBe("192.168.1.0/24");
    expect(truncateIp("::FFFF:1.2.3.4")).toBe("1.2.3.0/24");
  });

  it("takes the first hop of a comma list (X-Forwarded-For)", () => {
    expect(truncateIp("192.168.1.42, 10.0.0.1, 10.0.0.2")).toBe(
      "192.168.1.0/24",
    );
  });

  it("rejects out-of-range octets", () => {
    expect(truncateIp("1.2.3.999")).toBeNull();
    expect(truncateIp("256.1.2.3")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(truncateIp("not-an-ip")).toBeNull();
    expect(truncateIp("1.2.3")).toBeNull();
    expect(truncateIp("")).toBeNull();
    expect(truncateIp(null)).toBeNull();
    expect(truncateIp(undefined)).toBeNull();
  });
});

describe("truncateIp — IPv6", () => {
  it("truncates a full IPv6 to /48", () => {
    expect(truncateIp("2001:db8:1:0:0:0:0:1")).toBe("2001:0db8:0001::/48");
  });

  it("expands `::` shorthand correctly", () => {
    expect(truncateIp("2001:db8::1")).toBe("2001:0db8:0000::/48");
    expect(truncateIp("::1")).toBe("0000:0000:0000::/48");
    expect(truncateIp("fe80::abcd")).toBe("fe80:0000:0000::/48");
  });

  it("strips a zone identifier", () => {
    expect(truncateIp("fe80::1%en0")).toBe("fe80:0000:0000::/48");
  });

  it("handles bracketed [::1]:port form", () => {
    expect(truncateIp("[2001:db8::1]:5678")).toBe("2001:0db8:0000::/48");
  });

  it("rejects too many `::` shorthands", () => {
    expect(truncateIp("2001::db8::1")).toBeNull();
  });

  it("rejects non-hex groups", () => {
    expect(truncateIp("2001:db8:zzzz::1")).toBeNull();
  });
});
