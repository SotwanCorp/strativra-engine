/**
 * Google Ads, Floodlight and Google tag loader decoders.
 */
import type { CapturedRequest, DecodedHit, Vendor } from "../../types.ts";
import { decodeConsent } from "./consent.ts";
import {
  baseHit, cappedBody, hostIs, isGoogleHost, mergeQs, parseQs, safeDecode, setNum, setStr,
} from "./util.ts";

/* ---------------------------- Google Ads ---------------------------- */

const ADS_PATH = /\/pagead\/(?:conversion|viewthroughconversion|1p-conversion|1p-user-list)\/(\d+)\/?/;

export function isAdsRequest(host: string, path: string): boolean {
  if (hostIs(host, "googleadservices.com") && (path.startsWith("/pagead/conversion/") || path.startsWith("/ccm/collect"))) return true;
  if (hostIs(host, "googleads.g.doubleclick.net") && (path.startsWith("/pagead/viewthroughconversion/") || path.startsWith("/pagead/conversion/"))) return true;
  if (isGoogleHost(host) && (path.startsWith("/pagead/1p-conversion/") || path.startsWith("/pagead/1p-user-list/") || path.startsWith("/ccm/collect"))) return true;
  return false;
}

export function decodeAds(req: CapturedRequest, url: URL, firstParty: boolean): DecodedHit[] {
  const body = cappedBody(req);
  // /ccm/collect may carry params in a urlencoded body.
  const q = body && !body.trimStart().startsWith("{") ? mergeQs(url.searchParams, parseQs(body)) : url.searchParams;
  const m = ADS_PATH.exec(url.pathname);
  let id = m?.[1];
  if (!id) {
    const tid = q.get("tid") ?? q.get("id") ?? "";
    const t = /^AW-(\d+)$/i.exec(tid);
    if (t) id = t[1];
  }
  const label = q.get("label") || undefined;
  const hit = baseHit(req, "google_ads", label ? "conversion" : "remarketing", firstParty);
  if (id) hit.accountId = `AW-${id}`;
  if (label) hit.conversionLabel = label;
  const p = hit.params;
  setNum(p, "value", q.get("value"));
  setStr(p, "currency", q.get("currency_code") ?? q.get("currency"));
  setStr(p, "transaction_id", q.get("oid"));
  setStr(p, "page_location", q.get("url"));
  setStr(p, "en", q.get("en"));
  if (q.has("em") || q.has("ecsid")) p.ec = "present";
  if (url.pathname.includes("viewthroughconversion")) p.hit_type = "viewthrough";
  else if (url.pathname.includes("1p-")) p.hit_type = "1p";
  else if (url.pathname.startsWith("/ccm/")) p.hit_type = "ccm";
  else p.hit_type = "conversion";
  const consent = decodeConsent(q);
  if (consent) hit.consent = consent;
  return [hit];
}

/* ---------------------------- Floodlight ---------------------------- */

export function isFloodlight(host: string, path: string): boolean {
  if (hostIs(host, "fls.doubleclick.net")) return true;
  return hostIs(host, "ad.doubleclick.net") && /^\/activity/.test(path);
}

/** Floodlight uses ;key=value pairs in the path (activityi;src=1;type=x;cat=y). */
export function decodeFloodlight(req: CapturedRequest, url: URL, firstParty: boolean): DecodedHit[] {
  const kv: Record<string, string> = {};
  for (const seg of url.pathname.split(";").slice(1)) {
    const i = seg.indexOf("=");
    if (i <= 0) continue;
    kv[safeDecode(seg.slice(0, i))] = safeDecode(seg.slice(i + 1).replace(/\?.*$/, ""));
  }
  for (const [k, v] of url.searchParams) if (!(k in kv)) kv[k] = v;
  const hit = baseHit(req, "floodlight", kv.cat || "floodlight", firstParty);
  if (kv.src) hit.accountId = `DC-${kv.src}`;
  const p = hit.params;
  setStr(p, "type", kv.type);
  setStr(p, "cat", kv.cat);
  setStr(p, "ord", kv.ord);
  setNum(p, "value", kv.cost);
  setNum(p, "qty", kv.qty);
  for (const k of Object.keys(kv)) if (/^u\d+$/.test(k)) setStr(p, k, kv[k]);
  const consent = decodeConsent(kv);
  if (consent) hit.consent = consent;
  return [hit];
}

/* ------------------------ GTM / gtag loaders ------------------------ */

export function vendorForTagId(id: string): Vendor {
  const u = id.toUpperCase();
  if (u.startsWith("GTM-")) return "gtm";
  if (u.startsWith("G-")) return "ga4";
  if (u.startsWith("AW-")) return "google_ads";
  if (u.startsWith("DC-")) return "floodlight";
  return "other"; // GT- (Google tag) and anything new
}

export function isTagLoader(path: string): "gtm" | "gtag" | undefined {
  if (/\/gtm\.js$/.test(path)) return "gtm";
  if (/\/gtag\/js$/.test(path) || /\/gtag\/destination$/.test(path)) return "gtag";
  return undefined;
}

export function decodeTagLoader(
  req: CapturedRequest,
  url: URL,
  kind: "gtm" | "gtag",
  firstParty: boolean,
): DecodedHit[] {
  const id = url.searchParams.get("id") ?? "";
  if (kind === "gtm") {
    const hit = baseHit(req, "gtm", "container_load", firstParty);
    if (id) hit.accountId = id;
    setStr(hit.params, "l", url.searchParams.get("l"));
    return [hit];
  }
  const hit = baseHit(req, id ? vendorForTagId(id) : "other", "tag_load", firstParty);
  if (id) hit.accountId = id;
  return [hit];
}
