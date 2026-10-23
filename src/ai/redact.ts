/**
 * Redaction before any AI call, and the evidence index the AI cites from.
 *
 * Nothing leaves this process for TypeSafe or Anthropic unless it went
 * through `redactValue` / `buildEvidenceIndex`. Rules:
 * - emails, phone-like runs, long tokens (hashes, JWTs, click ids) are replaced
 * - values under user/client id keys (cid, uid, _ga, _fbp, gclid, em, ph, ...) are replaced
 * - URL query params with PII-like keys or values are dropped, the rest capped
 * - cookie values never exist here (CookieRecord has none); only name + domain
 * - every string, array, object and item is capped
 */
import type { Capture, CapturedRequest, DecodedHit, Finding, Report } from "../types.ts";
import type { EvidenceIndex, EvidenceItem, EvidenceKind, JsonSafe, Tier } from "./types.ts";

export const LIMITS = {
  maxString: 200,
  maxArray: 10,
  maxKeys: 24,
  maxDepth: 4,
  /** Bytes of JSON per evidence item. */
  maxItemBytes: 1500,
  maxHits: 60,
  maxDataLayer: 40,
  maxScreenshots: 20,
  maxCookies: 40,
  maxPages: 20,
};

const R = "[redacted]";

const EMAIL = /[a-z0-9._%+-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}/gi;
/** International or formatted phone numbers: +33 6 12 34 56 78, (212) 555-0100, 0612345678, and bare 10-11 digit runs (2125550100), but not ids like AW-1234567890. */
const PHONE = /\+\d[\d\s().-]{6,}\d|\b00\d{1,3}[\s.-]\d[\d\s().-]{5,}\d|\(\d{2,4}\)[\s.-]?\d{2,4}[\s.-]?\d{2,6}|\b0\d(?:[\s.-]?\d{2}){4}\b|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|(?<![\w-])\d{10,11}(?![\w-])/g;
/** Long opaque tokens: sha256 hex, base64url blobs, JWT segments, gclid-style ids. */
const LONG_TOKEN = /\b(?=[A-Za-z0-9_\-.]*\d)(?=[A-Za-z0-9_\-.]*[A-Za-z])[A-Za-z0-9_\-.]{32,}\b|\b[a-f0-9]{32,}\b/g;
/** GA client id shape: 1234567890.1234567890 (and GA1.1.x.y). */
const GA_CLIENT_ID = /\b(?:GA\d\.\d\.)?\d{6,10}\.\d{9,10}\b/g;

/** Keys whose values identify a person, a browser or a session. Matched on the leaf key, case-insensitive. */
const PII_KEY = new RegExp(
  "^(?:" +
    [
      "cid", "uid", "_ga.*", "_gid", "_gcl_.*", "_fbp", "_fbc", "fbp", "fbc", "fbclid", "gclid", "gbraid", "wbraid", "dclid",
      "msclkid", "ttclid", "li_fat_id", "twclid", "sid", "_s", "_p", "sct", "seg", "ecid", "user_?id", "userid", "client_?id",
      "session_?id", "external_?id", "visitor_?id", "device_?id", "anonymous_?id", "em", "ph", "fn", "ln", "db", "ge", "ct", "st",
      "zp", "country", "ud\\[.*\\]", "ud\\..*", "ued", "upd", "sst\\..*", "e?mail.*", "phone.*", "tel", "mobile", "first_?name",
      "last_?name", "full_?name", "address.*", "street", "city", "postal_?code", "zip(?:_?code)?", "birth.*", "dob", "password",
      "pass", "token", "access_?token", "id_?token", "auth.*", "code", "state", "nonce", "cookie", "set-cookie", "authorization",
      "ip", "ip_?address",
    ].join("|") +
    ")$",
  "i",
);

export function isPiiKey(key: string): boolean {
  return PII_KEY.test(key);
}

/** Redact free text. Order matters: emails before phones (digits inside addresses). */
export function redactText(input: string, max = LIMITS.maxString): string {
  let s = input;
  s = s.replace(EMAIL, "[email]");
  s = s.replace(GA_CLIENT_ID, "[id]");
  s = s.replace(LONG_TOKEN, "[token]");
  s = s.replace(PHONE, "[phone]");
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

/** Redact a URL: keep scheme, host, path; drop PII-like params, redact the rest; drop the hash unless it is a route. */
export function redactUrl(raw: string, maxParams = 12): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return redactText(raw.split("?")[0] ?? "");
  }
  const kept: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (kept.length >= maxParams) break;
    if (isPiiKey(k)) continue;
    if (redactText(v, 100_000) !== v) continue; // value held PII or a token: drop the param entirely
    const rv = v.length > 60 ? v.slice(0, 59) + "…" : v;
    kept.push(`${encodeURIComponent(k)}=${encodeURIComponent(rv)}`);
  }
  const route = u.hash.startsWith("#/") ? redactText(u.hash, 60) : "";
  const path = redactText(u.pathname, 120);
  return `${u.protocol}//${u.host}${path}${kept.length ? "?" + kept.join("&") : ""}${route}`;
}

/** Deep redaction with caps. Returns JSON-safe data only. */
export function redactValue(value: unknown, depth = 0, key = ""): JsonSafe {
  if (key && isPiiKey(key)) return R;
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return redactUrl(value);
    return redactText(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (depth >= LIMITS.maxDepth) return "[…]";
  if (Array.isArray(value)) {
    const out = value.slice(0, LIMITS.maxArray).map((v) => redactValue(v, depth + 1));
    if (value.length > LIMITS.maxArray) out.push(`[+${value.length - LIMITS.maxArray} more]`);
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, JsonSafe> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "function" || v === undefined) continue;
      if (n++ >= LIMITS.maxKeys) break;
      out[redactText(k, 60)] = redactValue(v, depth + 1, k);
    }
    return out;
  }
  return null;
}

/** Shrink data until its JSON fits the per-item byte cap (drop trailing keys, then give up). */
function capBytes(data: JsonSafe | undefined): JsonSafe | undefined {
  if (data === undefined) return undefined;
  const size = (d: JsonSafe) => Buffer.byteLength(JSON.stringify(d), "utf8");
  if (size(data) <= LIMITS.maxItemBytes) return data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const entries = Object.entries(data);
    while (entries.length > 0) {
      entries.pop();
      const d = Object.fromEntries(entries) as JsonSafe;
      if (size(d) <= LIMITS.maxItemBytes - 20) return { ...(d as object), _truncated: true } as JsonSafe;
    }
  }
  if (Array.isArray(data)) {
    const arr = [...data];
    while (arr.length > 0) {
      arr.pop();
      if (size(arr) <= LIMITS.maxItemBytes - 20) return [...arr, "[truncated]"];
    }
  }
  return "[truncated]";
}

export function makeItem(id: string, kind: EvidenceKind, summary: string, data?: unknown): EvidenceItem {
  const s = redactText(summary);
  const d = data === undefined ? undefined : capBytes(redactValue(data));
  const text = (s + " " + (d === undefined ? "" : JSON.stringify(d))).toLowerCase();
  return d === undefined ? { id, kind, summary: s, text } : { id, kind, summary: s, data: d, text };
}

/* ------------------------------------------------------------------ */
/* Index builder                                                        */
/* ------------------------------------------------------------------ */

const TRACKING_HOST = /(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|facebook\.com|facebook\.net|connect\.facebook|analytics\.tiktok\.com|bat\.bing\.com|px\.ads\.linkedin\.com|snap\.licdn\.com|ads\.linkedin\.com)/i;
const TRACKING_PATH = /\/(g\/collect|j\/collect|collect|tr|gtm\.js|gtag\/js|pagead\/|ccm\/collect)/i;

function isTrackingRequest(r: CapturedRequest): boolean {
  try {
    const u = new URL(r.url);
    return TRACKING_HOST.test(u.hostname) || TRACKING_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

/** Compact a raw request: host, path, safe params, first lines of a urlencoded body. */
function requestData(r: CapturedRequest): Record<string, unknown> {
  let host = "";
  let path = "";
  const params: Record<string, string> = {};
  try {
    const u = new URL(r.url);
    host = u.hostname;
    path = u.pathname;
    for (const [k, v] of u.searchParams) {
      if (Object.keys(params).length >= 16) break;
      params[k] = v; // redactValue below applies the key and value rules
    }
  } catch {
    host = "";
  }
  const body: Record<string, string>[] = [];
  if (r.postData && /^[\w.\[\]%-]+=/.test(r.postData)) {
    for (const line of r.postData.split("\n").slice(0, 3)) {
      const p: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(line)) {
        if (Object.keys(p).length >= 12) break;
        p[k] = v;
      }
      body.push(p);
    }
  }
  return {
    host,
    path,
    method: r.method,
    scenario: r.scenario,
    phase: r.phase,
    ...(Object.keys(params).length ? { params } : {}),
    ...(body.length ? { body } : {}),
    ...(r.blocked ? { blocked: r.blocked } : {}),
  };
}

function hitData(h: DecodedHit): Record<string, unknown> {
  let host = "";
  try {
    host = new URL(h.pageUrl).hostname;
  } catch {
    host = "";
  }
  return {
    vendor: h.vendor,
    event: h.eventName,
    account: h.accountId,
    label: h.conversionLabel,
    scenario: h.scenario,
    phase: h.phase,
    page: redactUrl(h.pageUrl, 0),
    pageHost: host,
    firstParty: h.firstParty,
    hasEventId: h.eventId ? true : undefined,
    params: h.params,
    consent: h.consent ? { raw: h.consent.raw, unknownLetters: h.consent.unknownLetters } : undefined,
    blocked: h.blocked,
  };
}

function findingData(f: Finding, refToId: Map<string, string>, locked: boolean): Record<string, unknown> {
  if (locked) return { title: f.title, severity: f.severity, locked: true };
  return {
    title: f.title,
    severity: f.severity,
    reproduced: f.reproduced,
    vendors: f.vendors,
    conversionTypes: f.conversionTypes,
    why: f.why,
    fix: f.fix.summary,
    evidence: f.evidence.slice(0, 5).map((e) => ({
      kind: e.kind,
      caption: e.caption,
      ...(e.ref && refToId.has(e.ref) ? { see: refToId.get(e.ref) } : {}),
      ...(e.data !== undefined ? { data: e.data } : {}),
    })),
  };
}

export interface IndexInput {
  report: Report;
  capture?: Capture;
  /** Decoded hits, when the decoder ran. Preferred over raw requests. */
  hits?: DecodedHit[];
  tier: Tier;
}

export interface BuiltIndex {
  index: EvidenceIndex;
  /** Finding evidence ref (request id, screenshot key) -> index id. */
  refToId: Map<string, string>;
  /** Index ids that belong to locked findings only (excluded on free). */
  lockedFindingIds: Set<string>;
}

/**
 * Build the redacted evidence index from a report and its capture.
 * On free, evidence referenced only by locked findings is left out entirely,
 * and locked findings appear as a stub (title + severity), so no AI can see
 * or reveal their evidence or fix.
 */
export function buildEvidenceIndex(input: IndexInput): BuiltIndex {
  const { report, capture, hits, tier } = input;
  const index: EvidenceIndex = new Map();
  const refToId = new Map<string, string>();
  const openSet = new Set(tier === "paid" ? report.findings.map((f) => f.id) : report.open);
  const lockedFindingIds = new Set(report.findings.filter((f) => !openSet.has(f.id)).map((f) => f.id));

  const openRefs = new Set<string>();
  const lockedRefs = new Set<string>();
  for (const f of report.findings) {
    for (const e of f.evidence) if (e.ref) (openSet.has(f.id) ? openRefs : lockedRefs).add(e.ref);
  }
  const hidden = (ref: string) => tier === "free" && lockedRefs.has(ref) && !openRefs.has(ref);
  const add = (item: EvidenceItem) => index.set(item.id, item);

  // r: report overview (always safe: what the free report shows anyway).
  add(
    makeItem("r", "report", `Scan of ${safeHost(report.finalUrl)} from ${report.region}`, {
      target: safeHost(report.finalUrl),
      kind: report.kind,
      pages: report.scan.pages,
      banner: report.scan.banner,
      counts: report.counts,
      conversions: report.conversions.map((c) => ({ type: c.type, status: c.status, summary: c.summary })),
      ...(report.scan.aborted ? { aborted: report.scan.aborted.reason } : {}),
    }),
  );

  report.stack.forEach((s, i) =>
    add(makeItem(`t${i + 1}`, "stack", `${s.name} (${s.vendor})`, { vendor: s.vendor, name: s.name, ids: s.ids, source: s.source, firstParty: s.firstParty })),
  );

  // Hits: decoded first, raw tracking requests otherwise.
  let n = 0;
  if (hits && hits.length) {
    for (const h of hits) {
      if (n >= LIMITS.maxHits) break;
      if (hidden(h.requestId)) continue;
      const id = `h${++n}`;
      refToId.set(h.requestId, id);
      add(makeItem(id, "hit", `${h.vendor} ${h.eventName} (${h.scenario}, ${h.phase})`, hitData(h)));
    }
  } else if (capture) {
    for (const sc of capture.scenarios) {
      for (const r of sc.requests) {
        if (n >= LIMITS.maxHits) break;
        if (!isTrackingRequest(r) && !refsAll(report).has(r.id)) continue;
        if (hidden(r.id)) continue;
        const id = `h${++n}`;
        refToId.set(r.id, id);
        add(makeItem(id, "hit", `${r.method} ${safeHost(r.url)} (${r.scenario}, ${r.phase})`, requestData(r)));
      }
    }
  }

  if (capture) {
    let d = 0, s = 0, c = 0;
    for (const sc of capture.scenarios) {
      for (const p of sc.dataLayer) {
        if (d >= LIMITS.maxDataLayer) break;
        const ev = p.payload && typeof p.payload === "object" && "event" in (p.payload as object) ? String((p.payload as { event: unknown }).event) : "push";
        add(makeItem(`d${++d}`, "datalayer", `dataLayer ${ev} (${p.scenario}, ${p.phase})`, { page: redactUrl(p.pageUrl, 0), scenario: p.scenario, phase: p.phase, payload: p.payload }));
      }
      for (const sh of sc.screenshots) {
        if (s >= LIMITS.maxScreenshots) break;
        if (hidden(sh.key)) continue;
        const id = `s${++s}`;
        refToId.set(sh.key, id);
        add(makeItem(id, "screenshot", sh.caption, { page: redactUrl(sh.pageUrl, 0), scenario: sh.scenario }));
      }
      for (const ck of sc.cookies) {
        if (c >= LIMITS.maxCookies) break;
        // Name and domain only. CookieRecord carries no value by design.
        add(makeItem(`c${++c}`, "cookie", `cookie ${ck.name} on ${ck.domain}`, { name: ck.name, domain: ck.domain, firstParty: ck.firstParty, scenario: ck.scenario, phase: ck.phase }));
      }
    }
    capture.pages.slice(0, LIMITS.maxPages).forEach((p, i) =>
      add(makeItem(`p${i + 1}`, "page", `${p.title ?? "page"} (${p.via})`, { url: redactUrl(p.url, 0), status: p.status, via: p.via, title: p.title })),
    );
    for (const cp of capture.conversionPoints) {
      add(
        makeItem(`cp:${cp.id}`, "conversion_point", cp.label, {
          type: cp.type,
          page: redactUrl(cp.pageUrl, 0),
          detectedBy: cp.detectedBy,
          confidence: cp.confidence,
          walk: cp.walk.map((w) => ({ step: w.name, action: w.action, ok: w.ok })),
        }),
      );
    }
  }

  // Report-side screenshot refs that were not in the capture.
  let s2 = [...index.keys()].filter((k) => /^s\d+$/.test(k)).length;
  for (const f of report.findings) {
    for (const e of f.evidence) {
      if (e.kind === "screenshot" && e.ref && !refToId.has(e.ref) && !hidden(e.ref)) {
        const id = `s${++s2}`;
        refToId.set(e.ref, id);
        add(makeItem(id, "screenshot", e.caption));
      }
    }
  }

  for (const f of report.findings) {
    const locked = lockedFindingIds.has(f.id) && tier === "free";
    add(makeItem(`f:${f.id}`, "finding", `${f.severity}: ${f.title}`, findingData(f, refToId, locked)));
  }

  return { index, refToId, lockedFindingIds: tier === "free" ? lockedFindingIds : new Set() };
}

let refsCache: { report: Report; refs: Set<string> } | undefined;
function refsAll(report: Report): Set<string> {
  if (refsCache?.report === report) return refsCache.refs;
  const refs = new Set<string>();
  for (const f of report.findings) for (const e of f.evidence) if (e.ref) refs.add(e.ref);
  refsCache = { report, refs };
  return refs;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return redactText(url, 80);
  }
}

/** Pick items by id (unknown ids skipped), for a prompt. */
export function pick(index: EvidenceIndex, ids: Iterable<string>): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const it = index.get(id);
    if (it) out.push(it);
  }
  return out;
}

/** The ids an open finding points at (itself + its resolved refs). */
export function findingEvidenceIds(f: Finding, refToId: Map<string, string>): string[] {
  const ids = [`f:${f.id}`];
  for (const e of f.evidence) if (e.ref && refToId.has(e.ref)) ids.push(refToId.get(e.ref)!);
  return ids;
}

/** What a model receives: id, kind, summary, data. Never `text`. */
export function forPrompt(items: EvidenceItem[]): Array<{ id: string; kind: string; summary: string; data?: JsonSafe }> {
  return items.map((it) => (it.data === undefined ? { id: it.id, kind: it.kind, summary: it.summary } : { id: it.id, kind: it.kind, summary: it.summary, data: it.data }));
}
