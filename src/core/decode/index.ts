/**
 * Decoders: CapturedRequest -> DecodedHit[]. Pure, browser-free, never throw.
 * An empty array means "not a tracking hit".
 *
 * First-party / sGTM heuristic (a LIKELY signal, not proof): a /g/collect,
 * gtm.js or gtag/js request served from the site's own registrable domain
 * (or a subdomain of it) is decoded like the Google original with
 * firstParty=true. Other first-party paths are decoded as GA4 only when they
 * carry the GA4 param shape (v=2 and tid=G-...). We only see the browser
 * half: a first-party endpoint may be sGTM, a CDN proxy or something else.
 * firstParty uses a simplified eTLD+1 (see util.ts for its limits).
 */
import type { CapturedRequest, DecodedHit } from "../../types.ts";
import { decodeGa4, looksLikeGa4 } from "./ga4.ts";
import {
  decodeAds, decodeFloodlight, decodeTagLoader, isAdsRequest, isFloodlight, isTagLoader,
} from "./google.ts";
import {
  decodeLinkedIn, decodeMeta, decodeTikTok, decodeUet, isLinkedIn, isMeta, isTikTok, isUet,
} from "./pixels.ts";
import { hostIs, isFirstParty, isGoogleHost, parseUrl } from "./util.ts";

export { decodeConsent, GCD_LETTERS } from "./consent.ts";
export { decodeItem } from "./ga4.ts";
export { isFirstParty, registrableDomain } from "./util.ts";

function isGa4Host(host: string): boolean {
  return hostIs(host, "google-analytics.com") || hostIs(host, "analytics.google.com");
}

function isGtmHost(host: string): boolean {
  return hostIs(host, "googletagmanager.com");
}

function route(req: CapturedRequest, siteHost: string): DecodedHit[] {
  if (!req || typeof req.url !== "string") return [];
  const url = parseUrl(req.url);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return [];
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const fp = isFirstParty(host, siteHost);

  // GA4 (Google endpoints, or first-party sGTM / proxy)
  if (/\/g\/collect$/.test(path) && (isGa4Host(host) || fp)) return decodeGa4(req, url, fp);
  if (isGa4Host(host) && /\/collect$/.test(path) && looksLikeGa4(url.searchParams)) return decodeGa4(req, url, fp);

  // Tag loaders (Google, or first-party)
  const loader = isTagLoader(path);
  if (loader && (isGtmHost(host) || fp)) return decodeTagLoader(req, url, loader, fp);

  if (isAdsRequest(host, path)) return decodeAds(req, url, fp);
  if (isFloodlight(host, path)) return decodeFloodlight(req, url, fp);
  if (isMeta(host, path)) return decodeMeta(req, url, fp);
  if (isLinkedIn(host, path)) return decodeLinkedIn(req, url, fp);
  if (isTikTok(host, path)) return decodeTikTok(req, url, fp);
  if (isUet(host, path)) return decodeUet(req, url, fp);

  // Other first-party paths with the GA4 param shape (likely sGTM, custom path).
  if (fp && looksLikeGa4(url.searchParams) && !isGoogleHost(host)) return decodeGa4(req, url, fp);
  return [];
}

export function decodeRequest(req: CapturedRequest, siteHost: string): DecodedHit[] {
  try {
    const hits = route(req, siteHost);
    // A request the capture layer aborted never reached the vendor.
    if (req.blocked) for (const h of hits) h.blocked = req.blocked;
    return hits;
  } catch {
    return [];
  }
}

export function decodeAll(reqs: CapturedRequest[], siteHost: string): DecodedHit[] {
  const out: DecodedHit[] = [];
  if (!Array.isArray(reqs)) return out;
  for (const r of reqs) for (const h of decodeRequest(r, siteHost)) out.push(h);
  return out;
}
