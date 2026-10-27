/**
 * Small helpers shared by the decoders. Pure, no I/O, never throw.
 */
import type { CapturedRequest, DecodedHit, Vendor } from "../../types.ts";

/** Hard cap on body parsing, matches the capture cap. */
export const MAX_BODY = 64 * 1024;

export type Params = DecodedHit["params"];

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

export function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function cappedBody(req: CapturedRequest): string {
  const b = req.postData;
  if (typeof b !== "string" || b.length === 0) return "";
  return b.length > MAX_BODY ? b.slice(0, MAX_BODY) : b;
}

/** URLSearchParams never throws on bad percent-encoding (it substitutes U+FFFD). */
export function parseQs(s: string): URLSearchParams {
  try {
    return new URLSearchParams(s);
  } catch {
    return new URLSearchParams();
  }
}

/** Merge b over a (b wins). */
export function mergeQs(a: URLSearchParams, b: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}

export function toNumber(s: string | undefined | null): number | undefined {
  if (s === undefined || s === null) return undefined;
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const EMAIL_RE = /[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Redacts e-mail addresses that leak into URLs or params (never keep PII). */
export function redact(s: string): string {
  return s.replace(EMAIL_RE, "[redacted-email]");
}

/** Strip scheme, path, port; lowercase. Accepts a host or a full URL. */
export function normHost(h: string): string {
  let s = (h || "").trim().toLowerCase();
  const u = s.includes("://") ? parseUrl(s) : undefined;
  if (u) s = u.hostname;
  s = s.replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return s;
}

/**
 * Common multi-part public suffixes. This is a simplified eTLD+1, not the
 * full Public Suffix List: hosts under unlisted multi-part suffixes (or
 * private suffixes like github.io, herokuapp.com) are treated as
 * registrable at two labels, so two unrelated tenants on such a suffix
 * would wrongly look first-party to each other.
 */
const MULTI_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "net.nz",
  "com.tn", "org.tn", "net.tn", "gov.tn", "ens.tn", "nat.tn", "tourism.tn", "info.tn",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "com.br", "net.br", "org.br",
  "com.mx", "com.ar", "com.co", "com.pe", "com.tr", "com.sg", "com.my", "com.hk",
  "com.cn", "net.cn", "org.cn", "com.tw", "co.kr", "co.in", "net.in", "org.in",
  "co.za", "org.za", "co.il", "com.eg", "com.sa", "com.pk", "com.ng", "co.ke",
  "com.ua", "com.pl", "com.ph", "com.vn", "co.id", "co.th", "com.qa", "com.kw",
  "com.lb", "com.ma", "co.ma", "com.dz", "com.gr", "com.cy", "com.mt", "gv.at", "co.at",
]);

export function registrableDomain(host: string): string {
  const h = normHost(host);
  if (!h) return "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return h; // IP
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last2 = labels.slice(-2).join(".");
  if (MULTI_SUFFIXES.has(last2)) return labels.slice(-3).join(".");
  return last2;
}

export function isFirstParty(reqHost: string, siteHost: string): boolean {
  const a = normHost(reqHost);
  const b = normHost(siteHost);
  if (!a || !b) return false;
  if (a === b) return true;
  const ra = registrableDomain(a);
  return ra !== "" && ra === registrableDomain(b);
}

/** True when host equals domain or is a subdomain of it. */
export function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

/** google.com, google.co.uk, google.com.tn, ... */
export function isGoogleHost(host: string): boolean {
  return /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);
}

export function baseHit(
  req: CapturedRequest,
  vendor: Vendor,
  eventName: string,
  firstParty: boolean,
): DecodedHit {
  return {
    requestId: req.id,
    scenario: req.scenario,
    phase: req.phase,
    ts: req.ts,
    pageUrl: req.pageUrl,
    vendor,
    eventName,
    params: {},
    firstParty,
  };
}

/** Copies a string param (redacted) when present and non-empty. */
export function setStr(p: Params, key: string, v: string | null | undefined): void {
  if (v !== null && v !== undefined && v !== "") p[key] = redact(v);
}

export function setNum(p: Params, key: string, v: string | null | undefined): void {
  const n = toNumber(v ?? undefined);
  if (n !== undefined) p[key] = n;
}
