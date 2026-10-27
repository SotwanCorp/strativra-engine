import type { CapturedRequest, ConsentKey, DecodedHit, Evidence, Vendor } from "../../types.ts";

export const GOOGLE_VENDORS: readonly Vendor[] = ["ga4", "google_ads", "floodlight"];
export const AD_VENDORS: readonly Vendor[] = ["google_ads", "floodlight", "meta", "linkedin", "tiktok", "ms_uet"];
/** Vendors whose hits count as analytics or marketing tracking (container loads excluded). */
export const TRACKING_VENDORS: readonly Vendor[] = ["ga4", "google_ads", "floodlight", "meta", "linkedin", "tiktok", "ms_uet", "sgtm"];

export const MAX_EVIDENCE = 5;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Last two labels, good enough for brand matching (not a public-suffix parser). */
export function brandLabel(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  if (parts.length < 2) return parts[0] ?? "";
  // co.uk, com.au style: take the label before the 2-letter second level.
  const sld = parts[parts.length - 2];
  if (parts.length >= 3 && (sld === "co" || sld === "com" || sld === "org" || sld === "net") && parts[parts.length - 1].length === 2) {
    return parts[parts.length - 3];
  }
  return sld;
}

export function registrable(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  const b = brandLabel(host);
  const i = parts.lastIndexOf(b);
  return i >= 0 ? parts.slice(i).join(".") : host;
}

/** URL without hash and trailing slash, for page matching. */
export function normUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

/** Same as normUrl but keeps hash routes (#/page), which SPAs use as routes. */
export function routeUrl(url: string): string {
  try {
    const u = new URL(url);
    const keepHash = u.hash.startsWith("#/") || u.hash.startsWith("#!/");
    if (!keepHash) u.hash = "";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

export function isTracking(h: DecodedHit): boolean {
  return TRACKING_VENDORS.includes(h.vendor);
}

export function hasConsentSignals(h: DecodedHit): boolean {
  return !!h.consent && (!!h.consent.raw.gcs || !!h.consent.raw.gcd);
}

export function current(h: DecodedHit, key: ConsentKey): string | undefined {
  return h.consent?.keys[key]?.current;
}

/**
 * Whether a hit effectively ran with storage granted.
 * Google hits with consent signals: ad_storage or analytics_storage current = granted.
 * Google hits with no signals: no Consent Mode, so the tag behaves as granted.
 * Non-Google vendors have no consent signal in the hit: firing at all counts.
 */
export function effectivelyGranted(h: DecodedHit): boolean {
  if (GOOGLE_VENDORS.includes(h.vendor)) {
    if (!hasConsentSignals(h)) return true;
    return current(h, "ad_storage") === "granted" || current(h, "analytics_storage") === "granted";
  }
  if (h.vendor === "sgtm") {
    if (!hasConsentSignals(h)) return true;
    return current(h, "ad_storage") === "granted" || current(h, "analytics_storage") === "granted";
  }
  return isTracking(h);
}

export function hitEvidence(h: DecodedHit, caption: string, extra?: Record<string, unknown>): Evidence {
  const data: Record<string, unknown> = {
    vendor: h.vendor,
    event: h.eventName,
    scenario: h.scenario,
    phase: h.phase,
    page: h.pageUrl,
  };
  if (h.accountId) data.id = h.accountId;
  if (h.consent?.raw.gcs) data.gcs = h.consent.raw.gcs;
  if (h.consent?.raw.gcd) data.gcd = h.consent.raw.gcd;
  if (extra) Object.assign(data, extra);
  return { kind: "hit", caption, ref: h.requestId, data };
}

export function requestEvidence(r: CapturedRequest, caption: string): Evidence {
  return { kind: "hit", caption, ref: r.id, data: { url: r.url.slice(0, 200), scenario: r.scenario, phase: r.phase, page: r.pageUrl } };
}

export function note(caption: string, data?: unknown): Evidence {
  return data === undefined ? { kind: "note", caption } : { kind: "note", caption, data };
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

/** One hit per (vendor, event, account, page), capped, for readable evidence. */
export function sampleHits(hits: DecodedHit[], max = MAX_EVIDENCE): DecodedHit[] {
  const seen = new Set<string>();
  const out: DecodedHit[] = [];
  for (const h of hits) {
    const k = `${h.vendor}|${h.eventName}|${h.accountId ?? ""}|${normUrl(h.pageUrl)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

export function vendorsOf(hits: DecodedHit[]): Vendor[] {
  return uniq(hits.map((h) => h.vendor));
}

export const VENDOR_NAMES: Record<Vendor, string> = {
  ga4: "Google Analytics 4",
  google_ads: "Google Ads",
  floodlight: "Floodlight",
  meta: "Meta Pixel",
  linkedin: "LinkedIn Insight",
  tiktok: "TikTok Pixel",
  ms_uet: "Microsoft Ads UET",
  gtm: "Google Tag Manager",
  sgtm: "Server-side tagging endpoint",
  other: "Other tag",
};

/** Reach from how many distinct pages are affected vs pages visited. */
export function reachFrom(affectedPages: number, totalPages: number): 1 | 2 | 3 {
  if (totalPages <= 0) return affectedPages > 0 ? 2 : 1;
  const r = affectedPages / totalPages;
  if (r >= 0.6) return 3;
  if (r >= 0.25) return 2;
  return 1;
}
