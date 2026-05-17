import { describe, it, expect } from "vitest";
import { assertSafeWebhookUrl } from "./ssrf.js";

describe("assertSafeWebhookUrl", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(assertSafeWebhookUrl("file:///etc/passwd")).rejects.toThrow(
      /http or https/,
    );
    await expect(assertSafeWebhookUrl("ftp://example.com/x")).rejects.toThrow(
      /http or https/,
    );
  });

  it("rejects URLs with embedded credentials", async () => {
    await expect(
      assertSafeWebhookUrl("http://user:pass@example.com/x"),
    ).rejects.toThrow(/credentials/);
  });

  it("rejects literal cloud metadata IP", async () => {
    await expect(
      assertSafeWebhookUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/non-routable/);
  });

  it("rejects loopback by literal and by name", async () => {
    await expect(
      assertSafeWebhookUrl("http://127.0.0.1:8080/"),
    ).rejects.toThrow(/non-routable/);
    await expect(
      assertSafeWebhookUrl("http://localhost:8080/"),
    ).rejects.toThrow(/not allowed/);
    await expect(assertSafeWebhookUrl("http://[::1]/")).rejects.toThrow(
      /non-routable/,
    );
  });

  it("rejects RFC1918 ranges", async () => {
    await expect(assertSafeWebhookUrl("http://10.0.0.5/")).rejects.toThrow(
      /non-routable/,
    );
    await expect(assertSafeWebhookUrl("http://172.16.0.5/")).rejects.toThrow(
      /non-routable/,
    );
    await expect(assertSafeWebhookUrl("http://192.168.1.5/")).rejects.toThrow(
      /non-routable/,
    );
  });

  it("rejects CGNAT", async () => {
    await expect(assertSafeWebhookUrl("http://100.64.0.1/")).rejects.toThrow(
      /non-routable/,
    );
  });

  it("rejects .local and .internal", async () => {
    await expect(assertSafeWebhookUrl("http://service.local/")).rejects.toThrow(
      /not allowed/,
    );
    await expect(assertSafeWebhookUrl("http://api.internal/")).rejects.toThrow(
      /not allowed/,
    );
  });

  it("rejects malformed URLs", async () => {
    await expect(assertSafeWebhookUrl("not a url")).rejects.toThrow();
  });
});
