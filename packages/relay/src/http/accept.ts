// RFC 9110 §12.5.1 Accept header negotiation.
//
// Used by routes that can serve more than one representation (the bridge's
// human-facing /s/:token errors can render as text/html for browsers or as
// the JSON envelope for agents). For single-representation routes we rely on
// the framework's default and don't need this.
//
// We parse the client's Accept header into media-range entries with their
// q-values, then walk the server's "offers" list and pick the one with the
// highest q. Wildcards (`*/*`, `text/*`) match offers but lose the tiebreak
// against more specific ranges. A missing Accept header is treated as `*/*`,
// the same default the RFC specifies.

export interface AcceptEntry {
  type: string; // "text" | "*"
  subtype: string; // "html" | "*"
  q: number; // 0.0 - 1.0
  // Specificity: 3 = "type/subtype", 2 = "type/*", 1 = "*/*". Used as the
  // tiebreaker when two offers have the same q.
  specificity: 1 | 2 | 3;
}

export function parseAccept(header: string | undefined | null): AcceptEntry[] {
  if (!header || !header.trim())
    return [{ type: "*", subtype: "*", q: 1, specificity: 1 }];
  const out: AcceptEntry[] = [];
  for (const raw of header.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const [mediaPart, ...paramParts] = part.split(";").map((s) => s.trim());
    const slash = mediaPart!.indexOf("/");
    if (slash < 0) continue;
    const type = mediaPart!.slice(0, slash).toLowerCase();
    const subtype = mediaPart!.slice(slash + 1).toLowerCase();
    if (!type || !subtype) continue;
    let q = 1;
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq < 0) continue;
      if (p.slice(0, eq).trim().toLowerCase() !== "q") continue;
      const v = Number(p.slice(eq + 1).trim());
      if (Number.isFinite(v) && v >= 0 && v <= 1) q = v;
    }
    const specificity: 1 | 2 | 3 =
      type === "*" && subtype === "*" ? 1 : subtype === "*" ? 2 : 3;
    out.push({ type, subtype, q, specificity });
  }
  return out;
}

function matches(
  entry: AcceptEntry,
  offerType: string,
  offerSubtype: string,
): boolean {
  if (entry.type === "*" && entry.subtype === "*") return true;
  if (entry.subtype === "*") return entry.type === offerType;
  return entry.type === offerType && entry.subtype === offerSubtype;
}

/**
 * Pick the best offer for the client's Accept header.
 *
 * Returns the chosen offer (verbatim from `offers`) or `null` if nothing in
 * `offers` is acceptable (i.e. every matching entry had q=0, or no entry
 * matched at all). Callers that want a fallback should provide the fallback
 * themselves; this function does not invent one.
 *
 * Tiebreakers, in order:
 *  1. higher q wins
 *  2. more specific media range wins (`text/html` > `text/*` > `*\/*`)
 *  3. earlier position in `offers` wins (server preference)
 */
export function selectMediaType(
  acceptHeader: string | undefined | null,
  offers: readonly string[],
): string | null {
  const entries = parseAccept(acceptHeader);
  let best: {
    offer: string;
    q: number;
    specificity: number;
    offerIdx: number;
  } | null = null;
  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i]!;
    const slash = offer.indexOf("/");
    if (slash < 0) continue;
    const oType = offer.slice(0, slash).toLowerCase();
    const oSub = offer.slice(slash + 1).toLowerCase();
    let bestEntry: AcceptEntry | null = null;
    for (const e of entries) {
      if (!matches(e, oType, oSub)) continue;
      if (e.q === 0) {
        // Explicit "do not send this type." Treat as a hard exclusion: even
        // if a less specific entry would otherwise match, the exclusion wins.
        bestEntry = e;
        break;
      }
      if (
        !bestEntry ||
        e.specificity > bestEntry.specificity ||
        (e.specificity === bestEntry.specificity && e.q > bestEntry.q)
      ) {
        bestEntry = e;
      }
    }
    if (!bestEntry || bestEntry.q === 0) continue;
    if (
      !best ||
      bestEntry.q > best.q ||
      (bestEntry.q === best.q && bestEntry.specificity > best.specificity) ||
      (bestEntry.q === best.q &&
        bestEntry.specificity === best.specificity &&
        i < best.offerIdx)
    ) {
      best = {
        offer,
        q: bestEntry.q,
        specificity: bestEntry.specificity,
        offerIdx: i,
      };
    }
  }
  return best ? best.offer : null;
}

/**
 * Convenience wrapper for the common case: "do you prefer HTML over JSON?"
 *
 * Returns true only when the client explicitly signals a preference for HTML
 * over JSON (i.e. proper negotiation picks `text/html` from `[text/html,
 * application/json]`). With no Accept header, or `Accept: *\/*`, JSON wins
 * because the offers list lists it first — which is what we want for the
 * bridge: agents and curl get the structured envelope; only browsers (which
 * advertise `text/html` with a high q) get the human-readable page.
 */
export function prefersHtml(acceptHeader: string | undefined | null): boolean {
  return (
    selectMediaType(acceptHeader, ["application/json", "text/html"]) ===
    "text/html"
  );
}
