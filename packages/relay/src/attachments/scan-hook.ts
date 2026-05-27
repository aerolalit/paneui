// Virus / content scan hook integration.
//
// When BLOB_SCAN_HOOK is set, every successful upload is POSTed to the
// configured URL with a JSON body containing the attachment's metadata and an
// HMAC-SHA256 signature in the `X-Pane-Scan-Signature` header. The scanner
// returns:
//   * 200 with `{ verdict: "clean" }` — attachment → ready
//   * 200 with `{ verdict: "infected", reason?: string }` — attachment → failed,
//     bytes deleted from storage
//   * anything else (timeout, non-2xx, missing/wrong signature on the
//     response) — fail-closed: attachment → failed, bytes deleted
//
// The scanner is expected to:
//   * Verify the HMAC signature on the incoming request (defends against
//     a leaky network path that lets an attacker forge "clean" responses
//     against the scanner).
//   * Echo the same HMAC in `X-Pane-Scan-Signature` on the response,
//     computed over the response body. The relay verifies this signature
//     before trusting the verdict — closes the same forgery channel in
//     the reverse direction.
//   * Fetch the attachment bytes if it needs to inspect content. The relay
//     supplies a fresh, single-use attachment token URL in the request body so
//     the scanner doesn't need an agent API key.
//
// SSRF guard: the URL is validated at startup via `assertSafeBlobScanHookUrl`
// (HTTPS-only, no RFC1918, no cloud-metadata ranges). A scan-hook URL that
// fails the guard makes the relay refuse to start.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import { getMasterKey } from "../crypto.js";

/** Default scan-hook timeout. Tight — a long-running scanner blocks uploads. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** The shape the scanner is expected to return. */
export interface ScanVerdict {
  verdict: "clean" | "infected";
  reason?: string;
}

export interface ScanRequestBody {
  attachment_id: string;
  scope: "agent" | "surface" | "template";
  mime: string;
  size: number;
  sha256: string;
  /**
   * A `/b/<token>` URL the scanner can GET to fetch the attachment bytes. Issued
   * by the scan-hook caller with a short TTL and the `once` flag so it
   * deletes itself after the scanner downloads.
   */
  download_url: string;
}

/**
 * POST the attachment's metadata to the configured BLOB_SCAN_HOOK and return the
 * scanner's verdict. Throws on:
 *   * timeout
 *   * non-2xx status
 *   * missing / wrong X-Pane-Scan-Signature on the response
 *   * malformed verdict JSON
 *
 * Callers (the route layer) treat any throw as "infected" — fail-closed.
 */
export async function callScanHook(
  config: Config,
  body: ScanRequestBody,
  opts: { timeoutMs?: number } = {},
): Promise<ScanVerdict> {
  const url = config.BLOB_SCAN_HOOK;
  if (!url) {
    throw new Error(
      "callScanHook invoked without BLOB_SCAN_HOOK set (programmer error)",
    );
  }

  const payload = JSON.stringify(body);
  const master = getMasterKey();
  const signature = signHmac(payload, master);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pane-scan-signature": signature,
      },
      body: payload,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`scan hook returned HTTP ${res.status}`);
  }

  const responseText = await res.text();
  const responseSig = res.headers.get("x-pane-scan-signature");
  if (!responseSig) {
    throw new Error("scan hook response missing X-Pane-Scan-Signature");
  }
  const expectedResponseSig = signHmac(responseText, master);
  if (!constantTimeEqual(responseSig, expectedResponseSig)) {
    throw new Error("scan hook response signature did not verify");
  }

  let verdict: ScanVerdict;
  try {
    verdict = JSON.parse(responseText) as ScanVerdict;
  } catch {
    throw new Error("scan hook response is not valid JSON");
  }
  if (verdict.verdict !== "clean" && verdict.verdict !== "infected") {
    throw new Error(
      `scan hook returned unknown verdict: ${JSON.stringify(verdict.verdict)}`,
    );
  }
  return verdict;
}

/** HMAC-SHA256 of `data` keyed on `master`, hex-encoded. */
function signHmac(data: string, master: Buffer): string {
  return createHmac("sha256", master).update(data, "utf8").digest("hex");
}

/** Constant-time hex string comparison. Both inputs must be the same length. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
