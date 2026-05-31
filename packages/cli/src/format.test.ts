import { describe, it, expect } from "vitest";
import { formatSurfaceCreated, humanCountdown } from "./format.js";

describe("humanCountdown", () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z

  it("renders days/hours when the gap is large", () => {
    expect(
      humanCountdown(
        new Date(base + 2 * 86400_000 + 3 * 3600_000).toISOString(),
        base,
      ),
    ).toBe("in 2d 3h");
  });

  it("renders hours/minutes for sub-day gaps", () => {
    expect(
      humanCountdown(
        new Date(base + 1 * 3600_000 + 5 * 60_000).toISOString(),
        base,
      ),
    ).toBe("in 1h 5m");
  });

  it("renders minutes for sub-hour gaps", () => {
    expect(
      humanCountdown(new Date(base + 45 * 60_000).toISOString(), base),
    ).toBe("in 45m");
  });

  it("renders seconds for sub-minute gaps", () => {
    expect(humanCountdown(new Date(base + 30_000).toISOString(), base)).toBe(
      "in 30s",
    );
  });

  it("returns 'expired' for past timestamps", () => {
    expect(humanCountdown(new Date(base - 1000).toISOString(), base)).toBe(
      "expired",
    );
  });

  it("returns 'expired' for an unparseable timestamp", () => {
    expect(humanCountdown("not-a-date", base)).toBe("expired");
  });
});

describe("formatSurfaceCreated", () => {
  const sample = {
    surface_id: "sur_abc123",
    title: "PR review",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    urls: {
      humans: ["https://relay.test/s/tok_h_one"],
      agent_stream: "wss://relay.test/v1/surfaces/sur_abc123/stream",
    },
  };

  it("includes the title, surface id, expiry countdown, and the human URL", () => {
    const out = formatSurfaceCreated(sample);
    expect(out).toContain("PR review");
    expect(out).toContain("sur_abc123");
    expect(out).toMatch(/Expires:.*in 59m|Expires:.*in 1h 0m/);
    expect(out).toContain("https://relay.test/s/tok_h_one");
    expect(out).toContain("wss://relay.test/v1/surfaces/sur_abc123/stream");
  });

  it("renders a QR matrix for the first human URL", () => {
    const out = formatSurfaceCreated(sample);
    // qrcode-terminal small mode uses Unicode block characters; assert that
    // at least one of them appears (any QR module is enough — the exact
    // matrix is a function of the URL and not worth pinning).
    expect(out).toMatch(/[▀-▟]/);
  });

  it("uses the dedup-hit headline when `created` is explicitly false", () => {
    const out = formatSurfaceCreated({ ...sample, created: false });
    expect(out).toContain("Existing surface reused");
    expect(out).not.toContain("Pane surface created");
  });

  it("handles the dedup case where no fresh human URLs were minted", () => {
    const out = formatSurfaceCreated({
      ...sample,
      created: false,
      urls: { humans: [], agent_stream: sample.urls.agent_stream },
    });
    expect(out).toContain("No human URLs minted");
    // No QR when there's no URL.
    expect(out).not.toMatch(/[▀-▟]/);
  });

  it("strips ANSI / control chars from interpolated server values", () => {
    const out = formatSurfaceCreated({
      ...sample,
      // A malicious title that would otherwise paint the terminal red until
      // the user resets it. We strip control chars before rendering.
      title: "\x1b[31mPwned\x1b[0m",
    });
    expect(out).not.toContain("\x1b[31m");
    expect(out).toContain("[31mPwned[0m"); // the bracket-text remains; the escape byte is gone
  });

  it("emits no ANSI escapes when color=false (default)", () => {
    const out = formatSurfaceCreated(sample);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI bold/dim when color=true", () => {
    const out = formatSurfaceCreated(sample, { color: true });
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/\x1b\[1m/);
  });
});
