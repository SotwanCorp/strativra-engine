/**
 * Strativra instant scanner (server-side only). Moved from the old Astro site
 * (SotwanCorp/strativra, site/src/lib/scan.ts) on 2026-10-23 when the site moved to WordPress.
 *
 * Fetches a page's RAW HTML (no JavaScript executed) and reports what a
 * crawler sees on first fetch, plus which tracking/consent tooling is present
 * in that HTML. Dependency-free: regex / string parsing only.
 *
 * Layout:
 *  1. Types
 *  2. Errors + URL validation + SSRF guards (IP classification)
 *  3. Safe fetching (manual redirects, DNS pinning via custom lookup, caps)
 *  4. Rate limiting (in-memory)
 *  5. HTML helpers
 *  6. analyzeHtml(html, meta)  <- pure, unit-testable
 *  7. scanUrl(input)           <- orchestrates fetch + analyze
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";

/* ------------------------------------------------------------------ */
/* 1. Types                                                            */
/* ------------------------------------------------------------------ */

export type Status = "pass" | "warn" | "fail" | "info";
export type Group = "indexability" | "tracking" | "consent" | "basics";

export interface Check {
  id: string;
  group: Group;
  label: string;
  status: Status;
  detail: string;
  evidence?: string;
}

export interface ScanResult {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  httpStatus: number;
  responseMs: number;
  htmlBytes: number;
  score: { indexability: number; tracking: number };
  likelyClientRendered: boolean;
  platformHints: string[];
  checks: Check[];
}

export type ScanErrorCode =
  | "invalid_url"
  | "blocked_host"
  | "fetch_failed"
  | "timeout"
  | "too_large"
  | "not_html"
  | "rate_limited";

export class ScanError extends Error {
  code: ScanErrorCode;
  constructor(code: ScanErrorCode, message: string) {
    super(message);
    this.name = "ScanError";
    this.code = code;
  }
}

/** Result of a side probe (robots.txt / sitemap.xml). status null = unreachable. */
export interface Probe {
  status: number | null;
  contentType?: string;
  /** First ~64KB of the body, only used for light parsing, never returned. */
  body?: string;
}

export interface AnalyzeMeta {
  url: string;
  finalUrl: string;
  httpStatus: number;
  responseMs: number;
  htmlBytes: number;
  headers: Record<string, string>; // lower-case names
  redirects: string[]; // URLs visited before finalUrl
  truncated: boolean;
  robotsTxt?: Probe;
  sitemap?: Probe;
}

/* ------------------------------------------------------------------ */
/* 2. URL validation + SSRF guards                                     */
/* ------------------------------------------------------------------ */

export const USER_AGENT = "StrativraScanner/1.0 (+https://strativra.com/scan)";
const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const TOTAL_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 2.5 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 3000;
const PROBE_MAX_BYTES = 64 * 1024;

/** Parse + validate a user-supplied URL. Throws ScanError(invalid_url). */
export function normalizeUrl(input: string): URL {
  const raw = (input ?? "").trim();
  if (!raw) throw new ScanError("invalid_url", "Enter a URL to scan.");
  if (raw.length > MAX_URL_LENGTH) throw new ScanError("invalid_url", "That URL is too long.");
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) throw new ScanError("invalid_url", "That URL contains invalid characters.");
  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  return validateParsedUrl(withScheme);
}

function validateParsedUrl(href: string): URL {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    throw new ScanError("invalid_url", "That doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new ScanError("invalid_url", "Only http and https URLs can be scanned.");
  if (u.username || u.password) throw new ScanError("invalid_url", "URLs with credentials are not allowed.");
  if (u.port && u.port !== "80" && u.port !== "443")
    throw new ScanError("invalid_url", "Only the standard ports 80 and 443 are allowed.");
  if (!u.hostname) throw new ScanError("invalid_url", "That URL has no hostname.");
  u.hash = "";
  return u;
}

function bareHost(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** Hostname-level (pre-DNS) block list. */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (net.isIP(h)) return isBlockedIp(h);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localdomain") || h.endsWith(".home.arpa"))
    return true;
  if (!h.includes(".")) return true; // single-label intranet names
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local + cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparsable: fail closed
  for (const [base, bits] of BLOCKED_V4) {
    const b = ipv4ToInt(base) as number;
    const size = 2 ** (32 - bits);
    if (Math.floor(n / size) === Math.floor(b / size)) return true;
  }
  return false;
}

/** Expand an IPv6 literal into 8 16-bit groups, or null if malformed. */
function expandV6(ip: string): number[] | null {
  let s = ip.split("%")[0].toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    s = s.slice(0, -v4[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const parts = halves.length === 1 ? head : [...head, ...Array(missing).fill("0"), ...tail];
  const out = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/**
 * True when the IP must never be fetched. IPv6 is allow-list based: only
 * global unicast 2000::/3 (minus documentation, 6to4, Teredo) passes. This
 * blocks ::1, ::, IPv4-mapped (::ffff:0:0/96), NAT64, unique-local fc00::/7,
 * link-local fe80::/10, multicast ff00::/8, etc.
 */
export function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind !== 6) return true;
  const g = expandV6(ip);
  if (!g) return true;
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true; // documentation
  return false;
}

/** Resolve all addresses and reject if ANY is non-public. */
async function assertPublicHost(host: string): Promise<void> {
  if (isBlockedHostname(host)) throw new ScanError("blocked_host", "That host can't be scanned.");
  if (net.isIP(host)) return; // already classified above
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    throw new ScanError("fetch_failed", "We couldn't resolve that domain name.");
  }
  if (!addrs.length) throw new ScanError("fetch_failed", "We couldn't resolve that domain name.");
  if (addrs.some((a) => isBlockedIp(a.address))) throw new ScanError("blocked_host", "That host can't be scanned.");
}

/**
 * DNS lookup used at connect time. Validating here (not only before the
 * request) closes the DNS-rebinding gap between "check" and "connect".
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }).then(
    (addrs) => {
      if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
        callback(new Error("blocked_host") as NodeJS.ErrnoException, "", 4);
        return;
      }
      if (options && (options as { all?: boolean }).all) {
        (callback as unknown as (e: null, a: typeof addrs) => void)(null, addrs);
      } else {
        callback(null, addrs[0].address, addrs[0].family);
      }
    },
    (err) => callback(err as NodeJS.ErrnoException, "", 4),
  );
};

/* ------------------------------------------------------------------ */
/* 3. Safe fetching                                                    */
/* ------------------------------------------------------------------ */

interface FetchOpts {
  timeoutMs: number;
  maxBytes: number;
  requireHtml: boolean;
}

interface FetchedPage {
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  truncated: boolean;
  finalUrl: string;
  redirects: string[];
}

interface HopResult {
  status: number;
  headers: Record<string, string>;
  body?: Buffer;
  truncated?: boolean;
}

function flattenHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

function decodeBody(buf: Buffer, contentType: string): string {
  const cs = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** One HTTP hop. Never follows redirects. Body is read only for non-redirects. */
function requestOnce(u: URL, signal: AbortSignal, opts: FetchOpts): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        method: "GET",
        hostname: bareHost(u),
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          "user-agent": USER_AGENT,
          accept: opts.requireHtml ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" : "text/plain,application/xml,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en",
        },
        agent: false,
        lookup: safeLookup,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = flattenHeaders(res.headers);
        if (status >= 300 && status < 400 && headers.location) {
          res.destroy();
          resolve({ status, headers });
          return;
        }
        if (opts.requireHtml && !/^(text\/html|application\/xhtml\+xml)\b/i.test(headers["content-type"] ?? "")) {
          res.destroy();
          reject(new ScanError("not_html", "That URL doesn't return an HTML page, so there's nothing to scan."));
          return;
        }
        let stream: NodeJS.ReadableStream = res;
        const enc = (headers["content-encoding"] ?? "").toLowerCase().trim();
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const finish = (truncated: boolean) => {
          if (done) return;
          done = true;
          res.destroy();
          resolve({ status, headers, body: Buffer.concat(chunks), truncated });
        };
        stream.on("data", (c: Buffer) => {
          const room = opts.maxBytes - total;
          if (c.length >= room) {
            if (room > 0) chunks.push(c.subarray(0, room));
            total = opts.maxBytes;
            finish(true); // cap hit: keep what we have
            return;
          }
          chunks.push(c);
          total += c.length;
        });
        stream.on("end", () => finish(false));
        stream.on("error", (err) => {
          if (done) return;
          if (total > 0) finish(false); // e.g. truncated gzip: use partial body
          else {
            done = true;
            reject(err);
          }
        });
        res.on("error", (err) => {
          if (!done && total === 0) {
            done = true;
            reject(err);
          } else finish(false);
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function mapFetchError(err: unknown, signal: AbortSignal): ScanError {
  if (err instanceof ScanError) return err;
  if (signal.aborted) return new ScanError("timeout", "The site took too long to respond (over 8 seconds).");
  const msg = err instanceof Error ? err.message : "";
  if (msg === "blocked_host") return new ScanError("blocked_host", "That host can't be scanned.");
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new ScanError("fetch_failed", "We couldn't resolve that domain name.");
  if (code === "ECONNREFUSED") return new ScanError("fetch_failed", "The server refused the connection.");
  if (/CERT|SSL|TLS|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH/i.test(code))
    return new ScanError("fetch_failed", "The site's HTTPS certificate could not be verified.");
  return new ScanError("fetch_failed", "We couldn't fetch that page.");
}

/** Follow up to MAX_REDIRECTS hops manually, re-validating every hop. */
async function fetchChain(start: URL, opts: FetchOpts): Promise<FetchedPage> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    let current = start;
    const redirects: string[] = [];
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHost(bareHost(current));
      let res: HopResult;
      try {
        res = await requestOnce(current, ac.signal, opts);
      } catch (err) {
        throw mapFetchError(err, ac.signal);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        redirects.push(current.href);
        let next: URL;
        try {
          next = validateParsedUrl(new URL(res.headers.location, current).href);
        } catch {
          throw new ScanError("fetch_failed", "The site redirected to an invalid or disallowed address.");
        }
        current = next;
        continue;
      }
      const buf = res.body ?? Buffer.alloc(0);
      return {
        status: res.status,
        headers: res.headers,
        body: decodeBody(buf, res.headers["content-type"] ?? ""),
        bytes: buf.length,
        truncated: !!res.truncated,
        finalUrl: current.href,
        redirects,
      };
    }
    throw new ScanError("fetch_failed", "The site redirected too many times (more than 5).");
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url: string): Promise<Probe> {
  try {
    const r = await fetchChain(new URL(url), { timeoutMs: PROBE_TIMEOUT_MS, maxBytes: PROBE_MAX_BYTES, requireHtml: false });
    return { status: r.status, contentType: r.headers["content-type"], body: r.body };
  } catch {
    return { status: null };
  }
}

/* ------------------------------------------------------------------ */
/* 4. Rate limiting                                                    */
/* ------------------------------------------------------------------ */

// NOTE: in-memory and per-process. It resets on every deploy/restart and is
// not shared between instances, so it is a best-effort abuse brake, not a
// hard guarantee. Use a shared store (Redis/KV) if strict limits are needed.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_IPS = 5000;
const hits = new Map<string, number[]>();

export function checkRateLimit(ip: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000)) };
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > MAX_TRACKED_IPS) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    if (hits.size > MAX_TRACKED_IPS) hits.delete(hits.keys().next().value as string);
  }
  return { ok: true, retryAfterSec: 0 };
}

/* ------------------------------------------------------------------ */
/* 5. HTML helpers (linear-time scanners, no catastrophic regexes)     */
/* ------------------------------------------------------------------ */

/** Lower-case ASCII only so indices stay aligned with the original string. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

function removeComments(html: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const s = html.indexOf("<!--", i);
    if (s === -1) return out + html.slice(i);
    out += html.slice(i, s);
    const e = html.indexOf("-->", s + 4);
    if (e === -1) return out;
    i = e + 3;
  }
}

interface Block {
  attrs: Record<string, string>;
  body: string;
}

/** Extract <tag ...>body</tag> blocks. An unclosed tag swallows the rest. */
function extractBlocks(html: string, lower: string, tag: string): Block[] {
  const out: Block[] = [];
  const open = `<${tag}`;
  const close = `</${tag}`;
  let i = 0;
  for (;;) {
    const s = lower.indexOf(open, i);
    if (s === -1) break;
    const after = lower.charAt(s + open.length);
    if (after && !/[\s>/]/.test(after)) {
      i = s + open.length;
      continue;
    }
    const gt = lower.indexOf(">", s);
    if (gt === -1) break;
    const attrs = parseAttrs(html.slice(s + open.length, gt));
    if (lower.charAt(gt - 1) === "/") {
      out.push({ attrs, body: "" });
      i = gt + 1;
      continue;
    }
    const e = lower.indexOf(close, gt);
    out.push({ attrs, body: html.slice(gt + 1, e === -1 ? html.length : e) });
    if (e === -1) break;
    const eg = lower.indexOf(">", e);
    i = eg === -1 ? html.length : eg + 1;
  }
  return out;
}

function removeBlocks(html: string, tags: string[]): string {
  let cur = html;
  for (const tag of tags) {
    const lower = asciiLower(cur);
    const open = `<${tag}`;
    const close = `</${tag}`;
    let out = "";
    let i = 0;
    for (;;) {
      const s = lower.indexOf(open, i);
      if (s === -1) {
        out += cur.slice(i);
        break;
      }
      const after = lower.charAt(s + open.length);
      if (after && !/[\s>/]/.test(after)) {
        out += cur.slice(i, s + open.length);
        i = s + open.length;
        continue;
      }
      out += cur.slice(i, s) + " ";
      const e = lower.indexOf(close, s);
      if (e === -1) break;
      const eg = lower.indexOf(">", e);
      i = eg === -1 ? cur.length : eg + 1;
    }
    cur = out;
  }
  return cur;
}

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

function tagAttrs(html: string, tag: string): Array<Record<string, string>> {
  const re = new RegExp(`<${tag}\\b([^>]{0,4000})>`, "gi");
  return [...html.matchAll(re)].map((m) => parseAttrs(m[1]));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (m, d, h, n) => {
    if (d || h) {
      const cp = d ? Number(d) : parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
    }
    return ENTITIES[String(n).toLowerCase()] ?? m;
  });
}

function squash(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

/** Short, single-line, control-char-free evidence string. */
function ev(s: string, n = 140): string {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

function allMatches(re: RegExp, s: string, group = 1): string[] {
  return [...s.matchAll(re)].map((m) => m[group]);
}

/* ------------------------------------------------------------------ */
/* 6. analyzeHtml                                                      */
/* ------------------------------------------------------------------ */

/**
 * Scoring weights per check id. Points: pass=1, warn=0.5, fail=0.
 * "info" checks are excluded from scoring. Score = 100 * earned / possible.
 * Indexability score = basics + indexability groups; tracking score =
 * tracking + consent groups.
 */
export const WEIGHTS: Record<string, number> = {
  // basics + indexability
  http_status: 3, https: 2, redirects: 1, response_time: 1,
  title: 3, meta_description: 2, h1: 2, word_count: 3, client_rendered: 5,
  canonical: 2, noindex: 5, lang: 1, open_graph: 1, json_ld: 1, robots_txt: 3, sitemap: 2,
  // tracking + consent
  gtm: 4, ga4: 3, duplicates: 3, ua_legacy: 1, consent_mode: 4, cmp: 2,
};

const STATUS_POINTS: Record<Status, number | null> = { pass: 1, warn: 0.5, fail: 0, info: null };

export function computeScores(checks: Check[]): { indexability: number; tracking: number } {
  const calc = (groups: Group[]): number => {
    let earned = 0;
    let possible = 0;
    for (const c of checks) {
      const pts = STATUS_POINTS[c.status];
      const w = WEIGHTS[c.id];
      if (!groups.includes(c.group) || pts === null || !w) continue;
      earned += pts * w;
      possible += w;
    }
    return possible ? Math.round((earned / possible) * 100) : 0;
  };
  // Blockers cap the score: a page Google sees as empty, or one marked noindex, can't rank
  // however tidy its meta tags are.
  const blocked = checks.some((c) => (c.id === "client_rendered" || c.id === "noindex") && c.status === "fail");
  const indexability = calc(["basics", "indexability"]);
  return { indexability: blocked ? Math.min(indexability, 35) : indexability, tracking: calc(["tracking", "consent"]) };
}

const CMPS: Array<[string, RegExp]> = [
  ["Cookiebot", /consent\.cookiebot\.com|cookiebot\.com\/|cookiebot-/i],
  ["OneTrust", /cdn\.cookielaw\.org|onetrust\.com|optanon/i],
  ["CookieYes", /cdn-cookieyes\.com|cookieyes\.com/i],
  ["Complianz", /complianz/i],
  ["Iubenda", /cdn\.iubenda\.com|iubenda\.com\/cs\//i],
  ["Usercentrics", /usercentrics\.eu|app\.usercentrics|usercentrics-/i],
  ["Termly", /app\.termly\.io|termly\.io\/resource-blocker/i],
  ["Osano", /osano\.com/i],
  ["Axeptio", /axept\.io|axeptio/i],
  ["Didomi", /sdk\.privacy-center\.org|didomi\.io|\bdidomi\b/i],
  ["CookieScript", /cookie-script\.com/i],
  ["Cookie Law Info", /cookie-law-info|cookielawinfo/i],
  ["Quantcast Choice", /quantcast\.mgr\.consensu\.org|quantcast\.com\/choice|cmp\.quantcast/i],
  ["Klaro", /klaro(\.min)?\.js|kiprotect\.com\/klaro/i],
  ["TCF-compatible CMP (generic)", /__tcfapi|__cmp\b/],
];

const PLATFORMS: Array<[string, (h: string, hdr: Record<string, string>) => boolean]> = [
  ["Lovable", (h) => /lovable\.app|lovable-tagger|gpteng\.co|lovable\.dev|\blovable\b/i.test(h)],
  ["Vite SPA", (h) => /<script[^>]+type=["']?module["']?[^>]+src=["']?\/assets\/index-[\w-]+\.js/i.test(h) || /\/@vite\/client|src=["']\/src\/main\.[tj]sx?["']/i.test(h)],
  ["Next.js", (h, x) => /__NEXT_DATA__|\/_next\//.test(h) || /next\.js/i.test(x["x-powered-by"] ?? "")],
  ["Webflow", (h) => /data-wf-page|webflow\.com|<meta[^>]+generator[^>]+webflow/i.test(h)],
  ["Framer", (h) => /framerusercontent\.com|<meta[^>]+generator[^>]+framer/i.test(h)],
  ["Wix", (h, x) => /wixstatic\.com|static\.parastorage\.com/i.test(h) || "x-wix-request-id" in x],
  ["Squarespace", (h) => /squarespace\.com|static1\.squarespace/i.test(h)],
  ["Shopify", (h) => /cdn\.shopify\.com|Shopify\.theme/i.test(h)],
  ["WordPress", (h) => /\/wp-content\/|\/wp-includes\/|<meta[^>]+generator[^>]+wordpress/i.test(h)],
  ["Bubble", (h) => /bubble\.io|bubbleapps\.io/i.test(h)],
  ["Bolt", (h) => /bolt\.new|stackblitz/i.test(h)],
  ["Astro", (h) => /astro-island|data-astro-|<meta[^>]+generator[^>]+astro/i.test(h)],
  ["Gatsby", (h) => /___gatsby|gatsby-/i.test(h)],
  ["Nuxt", (h) => /__NUXT__|\/_nuxt\//.test(h)],
];

function parseRobotsDisallowAll(body: string): boolean {
  // Group lines by user-agent; evaluate groups that apply to "*" or Googlebot.
  let agents: string[] = [];
  let lastWasAgent = false;
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[] }> = [];
  let cur: (typeof groups)[number] | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) agents = [];
      agents.push(val.toLowerCase());
      lastWasAgent = true;
      cur = null;
    } else if (key === "disallow" || key === "allow") {
      if (!cur) {
        cur = { agents: [...agents], disallow: [], allow: [] };
        groups.push(cur);
      }
      (key === "disallow" ? cur.disallow : cur.allow).push(val);
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  return groups.some(
    (g) =>
      g.agents.some((a) => a === "*" || a === "googlebot") &&
      g.disallow.includes("/") &&
      !g.allow.includes("/"),
  );
}

/** Pure analysis of raw HTML. No network. */
export function analyzeHtml(html: string, meta: AnalyzeMeta): ScanResult {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const stripped = removeComments(html);
  const lower = asciiLower(stripped);
  const bodyIdx = lower.search(/<body[\s>]/);
  const headPart = bodyIdx === -1 ? stripped : stripped.slice(0, bodyIdx);
  const bodyPart = bodyIdx === -1 ? stripped : stripped.slice(bodyIdx);
  const scripts = extractBlocks(stripped, lower, "script");
  const metas = tagAttrs(headPart, "meta");
  const links = tagAttrs(headPart, "link");
  const metaBy = (key: string): string | undefined =>
    metas.find((m) => (m.name ?? m.property ?? "").toLowerCase() === key)?.content;

  /* ---------------- basics ---------------- */
  const code = meta.httpStatus;
  add({
    id: "http_status", group: "basics", label: "HTTP status",
    status: code >= 200 && code < 300 ? "pass" : code >= 300 && code < 400 ? "warn" : "fail",
    detail: code >= 200 && code < 300
      ? `The page responded with ${code} OK.`
      : code >= 400
        ? `The page responded with ${code}. Search engines generally won't index error pages.`
        : `The page ended on a ${code} response.`,
    evidence: String(code),
  });

  const hops = meta.redirects.length;
  add({
    id: "redirects", group: "basics", label: "Redirects",
    status: hops === 0 ? "pass" : hops <= 2 ? "info" : "warn",
    detail: hops === 0
      ? "No redirects: the URL you entered is the final URL."
      : hops <= 2
        ? `The URL redirected ${hops} time${hops > 1 ? "s" : ""} to ${ev(meta.finalUrl, 120)}. That's normal for http→https or www changes.`
        : `The URL passed through ${hops} redirects. Long chains slow crawling and can lose link signals.`,
    evidence: hops ? ev([...meta.redirects, meta.finalUrl].join(" → "), 300) : undefined,
  });

  const isHttps = meta.finalUrl.startsWith("https://");
  add({
    id: "https", group: "basics", label: "HTTPS",
    status: isHttps ? "pass" : "fail",
    detail: isHttps ? "The page is served over HTTPS." : "The page is served over plain HTTP. Browsers flag it as not secure and Google prefers HTTPS.",
  });

  const ms = meta.responseMs;
  add({
    id: "response_time", group: "basics", label: "Response time",
    status: ms < 1500 ? "pass" : ms < 3000 ? "warn" : "fail",
    detail: `The HTML arrived in about ${ms} ms, measured once from our server. Treat it as a rough indication, not a lab-grade speed test.`,
    evidence: `${ms} ms`,
  });

  /* ---------------- indexability ---------------- */
  const titleRaw = /<title\b[^>]{0,500}>([\s\S]{0,2000}?)<\/title\s*>/i.exec(headPart)?.[1];
  const title = titleRaw === undefined ? "" : squash(titleRaw);
  const genericTitle = /^(vite|react|lovable|vite \+ react|create next app|untitled|document|index)\b.*(app|project|generated)?$/i.test(title) && title.length < 40;
  if (!title) {
    add({ id: "title", group: "indexability", label: "Page title", status: "fail", detail: "No <title> tag found in the raw HTML. Google will invent a title for your result or show the URL." });
  } else if (genericTitle) {
    add({ id: "title", group: "indexability", label: "Page title", status: "warn", detail: "The title looks like a framework or template default rather than a real page title.", evidence: ev(title) });
  } else if (title.length < 10 || title.length > 70) {
    add({ id: "title", group: "indexability", label: "Page title", status: "warn", detail: `The title is ${title.length} characters. Aim for roughly 10-70 so it isn't too thin or truncated in results.`, evidence: ev(title) });
  } else {
    add({ id: "title", group: "indexability", label: "Page title", status: "pass", detail: `A title is present (${title.length} characters).`, evidence: ev(title) });
  }

  const desc = squash(metaBy("description") ?? "");
  add({
    id: "meta_description", group: "indexability", label: "Meta description",
    status: !desc ? "fail" : desc.length < 70 || desc.length > 170 ? "warn" : "pass",
    detail: !desc
      ? "No meta description in the raw HTML. Google will pull a snippet from the page instead, which is less controllable."
      : desc.length < 70 || desc.length > 170
        ? `The meta description is ${desc.length} characters; roughly 70-160 reads best in results.`
        : `A meta description is present (${desc.length} characters).`,
    evidence: desc ? ev(desc) : undefined,
  });

  const bodyClean = removeBlocks(bodyPart, ["script", "style", "noscript", "svg", "template"]);
  const h1Count = (bodyClean.match(/<h1[\s>/]/gi) ?? []).length;
  add({
    id: "h1", group: "indexability", label: "H1 heading",
    status: h1Count === 1 ? "pass" : h1Count === 0 ? "fail" : "warn",
    detail: h1Count === 1
      ? "Exactly one <h1> in the raw HTML."
      : h1Count === 0
        ? "No <h1> in the raw HTML. If it's added by JavaScript, Google's first fetch doesn't see it."
        : `${h1Count} <h1> tags found. One clear main heading per page is the safer pattern.`,
    evidence: `${h1Count} found`,
  });

  const text = decodeEntities(bodyClean.replace(/<[^>]*>/g, " "));
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  const emptyMount = /<div\b[^>]*\bid\s*=\s*["']?(?:root|app|__next|__nuxt|svelte)["']?[^>]*>\s*<\/div>/i.test(bodyPart);
  const rootMount = /\bid\s*=\s*["']?(?:root|app|__next|__nuxt)["']?/i.test(bodyPart);
  const moduleScripts = scripts.filter((s) => (s.attrs.type ?? "").toLowerCase() === "module" && s.attrs.src);
  const likelyClientRendered = words < 80 && (emptyMount || rootMount || moduleScripts.length > 0);

  add({
    id: "client_rendered", group: "indexability", label: "Content visible without JavaScript",
    status: likelyClientRendered ? "fail" : "pass",
    detail: likelyClientRendered
      ? "Google's first look at this page is nearly empty. The visible content appears to be built in the browser by JavaScript, so it depends on Google's delayed rendering queue to be seen at all."
      : "The raw HTML contains real, readable content, so Google can see it on first fetch.",
    evidence: `${words} words in raw body${emptyMount ? "; empty root mount element" : ""}${moduleScripts.length ? `; ${moduleScripts.length} module script(s)` : ""}`,
  });

  add({
    id: "word_count", group: "indexability", label: "Text in raw HTML",
    status: words >= 80 ? "pass" : likelyClientRendered ? "fail" : "warn",
    detail: words >= 80
      ? `About ${words} words of visible text in the raw HTML.`
      : `Only about ${words} words of visible text in the raw HTML. ${likelyClientRendered ? "Most of the page is likely rendered by JavaScript." : "The page may be very thin on content."}`,
    evidence: `${words} words`,
  });

  const canon = links.find((l) => (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))?.href?.trim();
  let canonStatus: Status = "pass";
  let canonDetail = "A canonical URL is declared and is absolute.";
  if (!canon) {
    canonStatus = "warn";
    canonDetail = "No canonical link in the raw HTML. Duplicate URL variants (http/https, www, parameters) may compete with each other.";
  } else if (!/^https?:\/\//i.test(canon)) {
    canonStatus = "warn";
    canonDetail = "The canonical URL is relative. Google recommends absolute URLs.";
  } else {
    try {
      if (new URL(canon).host.replace(/^www\./, "") !== new URL(meta.finalUrl).host.replace(/^www\./, "")) {
        canonStatus = "warn";
        canonDetail = "The canonical points to a different domain than the page you scanned. Intentional for syndicated content, otherwise worth checking.";
      }
    } catch {
      canonStatus = "warn";
      canonDetail = "The canonical URL could not be parsed.";
    }
  }
  add({ id: "canonical", group: "indexability", label: "Canonical URL", status: canonStatus, detail: canonDetail, evidence: canon ? ev(canon) : undefined });

  // noindex: meta robots/googlebot and X-Robots-Tag
  const noindexSources: string[] = [];
  for (const m of metas) {
    const n = (m.name ?? "").toLowerCase();
    if ((n === "robots" || n === "googlebot") && /\b(noindex|none)\b/i.test(m.content ?? "")) noindexSources.push(`meta ${n}: ${m.content}`);
  }
  for (const part of (meta.headers["x-robots-tag"] ?? "").split(/,(?=\s*[a-z-]+\s*:)/i)) {
    const bot = /^\s*([a-z][a-z0-9-]*)\s*:\s*(.*)$/i.exec(part);
    const applies = !bot || /^(googlebot|google)$/i.test(bot[1]) || !/bot$/i.test(bot[1]);
    const directives = bot && /bot$|^google$/i.test(bot[1]) ? bot[2] : part;
    if (applies && /\b(noindex|none)\b/i.test(directives)) noindexSources.push(`X-Robots-Tag: ${part.trim()}`);
  }
  add({
    id: "noindex", group: "indexability", label: "Indexing allowed (noindex)",
    status: noindexSources.length ? "fail" : "pass",
    detail: noindexSources.length
      ? "A noindex directive tells Google to keep this page out of search results. If that's not intentional, it's blocking all organic traffic to the page."
      : "No noindex directive found in the meta tags or X-Robots-Tag header.",
    evidence: noindexSources.length ? ev(noindexSources.join(" | "), 200) : undefined,
  });

  const htmlTag = /<html\b([^>]{0,2000})>/i.exec(stripped);
  const lang = htmlTag ? parseAttrs(htmlTag[1]).lang?.trim() : "";
  add({
    id: "lang", group: "indexability", label: "Language attribute",
    status: lang ? "pass" : "warn",
    detail: lang ? `The <html> tag declares lang="${ev(lang, 20)}".` : "No lang attribute on <html>. It helps search engines and screen readers pick the right language.",
    evidence: lang ? ev(lang, 20) : undefined,
  });

  const og = ["og:title", "og:description", "og:image"].filter((k) => metaBy(k));
  add({
    id: "open_graph", group: "indexability", label: "Open Graph tags",
    status: og.length === 3 ? "pass" : "warn",
    detail: og.length === 3
      ? "og:title, og:description and og:image are present, so shared links get a proper preview."
      : `Missing ${["og:title", "og:description", "og:image"].filter((k) => !og.includes(k)).join(", ")}. Shared links on social and chat apps may show a bare or wrong preview.`,
    evidence: og.length ? og.join(", ") : undefined,
  });

  const ldTypes: string[] = [];
  let ldBlocks = 0;
  let ldInvalid = 0;
  for (const s of scripts) {
    if ((s.attrs.type ?? "").toLowerCase() !== "application/ld+json") continue;
    ldBlocks++;
    try {
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === "object") {
          const o = n as Record<string, unknown>;
          const t = o["@type"];
          if (typeof t === "string") ldTypes.push(t);
          else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && ldTypes.push(x));
          if (o["@graph"]) walk(o["@graph"]);
        }
      };
      walk(JSON.parse(s.body));
    } catch {
      ldInvalid++;
    }
  }
  add({
    id: "json_ld", group: "indexability", label: "Structured data (JSON-LD)",
    status: ldBlocks === 0 ? "warn" : ldInvalid === ldBlocks ? "fail" : ldInvalid ? "warn" : "pass",
    detail: ldBlocks === 0
      ? "No JSON-LD structured data in the raw HTML."
      : ldInvalid
        ? `${ldInvalid} of ${ldBlocks} JSON-LD block(s) contain invalid JSON and will be ignored by Google.`
        : `${ldBlocks} JSON-LD block(s) found${ldTypes.length ? ` (types: ${uniq(ldTypes).slice(0, 8).join(", ")})` : ""}.`,
    evidence: ldTypes.length ? ev(uniq(ldTypes).join(", ")) : undefined,
  });

  // robots.txt
  if (meta.robotsTxt) {
    const r = meta.robotsTxt;
    const looksHtml = /<\s*(!doctype|html|head|body)\b/i.test((r.body ?? "").slice(0, 500));
    if (r.status === null) {
      add({ id: "robots_txt", group: "indexability", label: "robots.txt", status: "warn", detail: "We couldn't fetch /robots.txt (timeout or connection problem), so we couldn't check it." });
    } else if (r.status === 200 && !looksHtml) {
      const blocked = parseRobotsDisallowAll(r.body ?? "");
      add({
        id: "robots_txt", group: "indexability", label: "robots.txt",
        status: blocked ? "fail" : "pass",
        detail: blocked
          ? "robots.txt contains 'Disallow: /' for all crawlers (or Googlebot), which blocks the entire site from being crawled."
          : "robots.txt is reachable and doesn't block the whole site.",
      });
    } else if (r.status === 200 && looksHtml) {
      add({ id: "robots_txt", group: "indexability", label: "robots.txt", status: "warn", detail: "/robots.txt returns an HTML page instead of a robots file. This is typical of single-page apps that serve index.html for every path, so crawlers get no real rules or sitemap pointer." });
    } else if (r.status === 404 || r.status === 410) {
      add({ id: "robots_txt", group: "indexability", label: "robots.txt", status: "warn", detail: "No robots.txt found. Crawling still works, but you can't point crawlers to your sitemap from there." });
    } else {
      add({ id: "robots_txt", group: "indexability", label: "robots.txt", status: "warn", detail: `/robots.txt responded with ${r.status}. Persistent server errors there can make Google slow or stop crawling.`, evidence: String(r.status) });
    }
  }

  // sitemap
  if (meta.robotsTxt || meta.sitemap) {
    const rb = meta.robotsTxt?.status === 200 ? meta.robotsTxt.body ?? "" : "";
    const fromRobots = /^\s*sitemap\s*:\s*\S+/im.test(rb) && !/<\s*(!doctype|html)\b/i.test(rb.slice(0, 500));
    const s = meta.sitemap;
    const sBody = (s?.body ?? "").trimStart().slice(0, 500);
    const xmlOk = !!s && s.status === 200 && /^(<\?xml|<urlset|<sitemapindex)/i.test(sBody);
    add({
      id: "sitemap", group: "indexability", label: "XML sitemap",
      status: fromRobots || xmlOk ? "pass" : "warn",
      detail: fromRobots
        ? "A sitemap is referenced in robots.txt."
        : xmlOk
          ? "A sitemap is available at /sitemap.xml."
          : "No sitemap found in robots.txt or at /sitemap.xml. A sitemap helps Google discover pages, especially on new or JavaScript-heavy sites.",
    });
  }

  if (meta.truncated) {
    add({ id: "truncated", group: "basics", label: "Large page", status: "info", detail: "The HTML is larger than 2.5 MB, so we analyzed only the first 2.5 MB. Items near the end of the page may be missed." });
  }

  /* ---------------- tracking ---------------- */
  const gtmIds = uniq(allMatches(/googletagmanager\.com\/(?:gtm\.js|ns\.html)\?[^"'\s>]*?\bid=(GTM-[A-Z0-9]+)/gi, stripped)
    .concat(allMatches(/\(\s*window\s*,\s*document\s*,\s*['"]script['"]\s*,\s*['"][\w$]+['"]\s*,\s*['"](GTM-[A-Z0-9]+)['"]\s*\)/g, stripped))
    .map((s) => s.toUpperCase()));
  const gtmLoads = [
    ...allMatches(/<script\b[^>]*\bsrc\s*=\s*["']?[^"'\s>]*googletagmanager\.com\/gtm\.js\?[^"'\s>]*?\bid=(GTM-[A-Z0-9]+)/gi, stripped),
    ...allMatches(/\(\s*window\s*,\s*document\s*,\s*['"]script['"]\s*,\s*['"][\w$]+['"]\s*,\s*['"](GTM-[A-Z0-9]+)['"]\s*\)/g, stripped),
  ].map((s) => s.toUpperCase());
  const gtmDup = uniq(gtmLoads.filter((id, i) => gtmLoads.indexOf(id) !== i));

  const ga4Loads = allMatches(/googletagmanager\.com\/gtag\/js\?[^"'\s>]*?\bid=(G-[A-Z0-9]+)/gi, stripped).map((s) => s.toUpperCase());
  const ga4Configs = allMatches(/gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]/g, stripped).map((s) => s.toUpperCase());
  const ga4Ids = uniq([...ga4Loads, ...ga4Configs]);
  const dupLoadIds = uniq(ga4Loads.filter((id, i) => ga4Loads.indexOf(id) !== i));
  const dupConfigIds = uniq(ga4Configs.filter((id, i) => ga4Configs.indexOf(id) !== i));
  const uaIds = uniq(allMatches(/\b(UA-\d{4,10}-\d{1,3})\b/g, stripped));
  const adsIds = uniq(allMatches(/\b(AW-\d{6,12})\b/g, stripped));

  add({
    id: "gtm", group: "tracking", label: "Google Tag Manager",
    status: gtmIds.length ? "pass" : "info",
    detail: gtmIds.length
      ? `Google Tag Manager container${gtmIds.length > 1 ? "s" : ""} found: ${gtmIds.join(", ")}. What the container actually fires can't be seen without running the page.`
      : "No Google Tag Manager snippet found in the raw HTML.",
    evidence: gtmIds.join(", ") || undefined,
  });

  if (ga4Ids.length) {
    add({
      id: "ga4", group: "tracking", label: "Google Analytics 4",
      status: "pass",
      detail: `GA4 measurement ID${ga4Ids.length > 1 ? "s" : ""} found directly in the page: ${ga4Ids.join(", ")}. We can see it's installed, not whether events are actually arriving.`,
      evidence: ga4Ids.join(", "),
    });
  } else if (gtmIds.length) {
    add({
      id: "ga4", group: "tracking", label: "Google Analytics 4",
      status: "info",
      detail: "No direct GA4 tag in the HTML. GA4 may be configured inside GTM; we can't confirm without running the page.",
    });
  } else {
    add({
      id: "ga4", group: "tracking", label: "Google Analytics 4",
      status: "warn",
      detail: "No GA4 or Google Tag Manager found in the raw HTML. It could be injected by JavaScript after load or after consent, but we can't see it.",
    });
  }

  if (uaIds.length) {
    add({ id: "ua_legacy", group: "tracking", label: "Universal Analytics (legacy)", status: "warn", detail: "A legacy Universal Analytics ID (UA-) is present. UA stopped processing data in 2023, so it collects nothing.", evidence: uaIds.join(", ") });
  }

  // duplicates
  const dupNotes: string[] = [];
  if (dupLoadIds.length) dupNotes.push(`gtag.js for ${dupLoadIds.join(", ")} is loaded more than once`);
  if (dupConfigIds.length) dupNotes.push(`gtag('config') for ${dupConfigIds.join(", ")} is called more than once, which usually double-counts page views`);
  if (gtmDup.length) dupNotes.push(`GTM container ${gtmDup.join(", ")} is installed more than once`);
  if (gtmIds.length || ga4Ids.length) {
    add({
      id: "duplicates", group: "tracking", label: "Duplicate installs",
      status: dupNotes.length ? "warn" : "pass",
      detail: dupNotes.length
        ? `Possible double counting: ${dupNotes.join("; ")}.`
        : "No duplicate GTM or GA4 installs detected in the HTML.",
      evidence: dupNotes.length ? ev(dupNotes.join("; "), 200) : undefined,
    });
    if (gtmIds.length && ga4Ids.length) {
      add({
        id: "gtm_plus_gtag", group: "tracking", label: "GTM and direct gtag together", status: "info",
        detail: "Both GTM and a direct GA4 tag are on the page. That's fine if the GTM container doesn't also fire a GA4 tag for the same ID; if it does, events would be counted twice. Check the container to be sure.",
      });
    }
  }

  const pixel = (id: string, label: string, found: boolean, ids: string[], note: string) => {
    if (found) add({ id, group: "tracking", label, status: "info", detail: ids.length ? `${label} detected (${ids.join(", ")}). ${note}` : `${label} detected. ${note}`, evidence: ids.join(", ") || undefined });
  };
  pixel("google_ads", "Google Ads tag", adsIds.length > 0, adsIds, "Conversion tracking should be consent-gated for EU/UK visitors.");
  const fbIds = allMatches(/fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{6,})/g, stripped);
  const fbDup = uniq(fbIds.filter((id, i) => fbIds.indexOf(id) !== i));
  const hasFb = /connect\.facebook\.net\/[^"'\s>]*\/fbevents\.js/i.test(stripped) || fbIds.length > 0;
  pixel("meta_pixel", "Meta Pixel", hasFb, uniq(fbIds), fbDup.length ? `Pixel ${fbDup.join(", ")} is initialised more than once, which can duplicate events.` : "");
  const liIds = allMatches(/_linkedin_partner_id\s*=\s*["']?(\d+)/g, stripped);
  pixel("linkedin", "LinkedIn Insight Tag", /snap\.licdn\.com\/li\.lms-analytics|_linkedin_partner_id/i.test(stripped), uniq(liIds), "");
  const ttIds = allMatches(/ttq\.load\(\s*['"]([A-Z0-9]+)['"]/g, stripped);
  pixel("tiktok", "TikTok Pixel", /analytics\.tiktok\.com\/i18n\/pixel|ttq\.load/i.test(stripped), uniq(ttIds), "");
  const uetIds = allMatches(/\bti\s*:\s*["'](\d{5,})["']/g, stripped);
  pixel("ms_uet", "Microsoft Advertising UET", /bat\.bing\.com\/bat\.js|\buetq\b/i.test(stripped), uniq(uetIds), "");
  const hjIds = allMatches(/hjid\s*:\s*(\d+)/g, stripped);
  pixel("hotjar", "Hotjar", /static\.hotjar\.com|\bhj\(/i.test(stripped), uniq(hjIds), "");
  const clIds = allMatches(/clarity\.ms\/tag\/([a-z0-9]+)/gi, stripped);
  pixel("clarity", "Microsoft Clarity", /clarity\.ms\/tag/i.test(stripped), uniq(clIds), "");

  const tagsPresent = gtmIds.length > 0 || ga4Ids.length > 0 || adsIds.length > 0 || hasFb ||
    /snap\.licdn\.com|analytics\.tiktok\.com|bat\.bing\.com|static\.hotjar\.com|clarity\.ms\/tag/i.test(stripped);

  // dataLayer ordering vs GTM
  if (gtmIds.length) {
    const gtmPos = stripped.search(/googletagmanager\.com\/gtm\.js|\(\s*window\s*,\s*document\s*,\s*['"]script['"]/);
    const dlPos = stripped.search(/dataLayer\s*=\s*(window\.dataLayer|\[)|window\.dataLayer\s*=|dataLayer\.push\(/);
    const early = dlPos !== -1 && gtmPos !== -1 && dlPos < gtmPos;
    add({
      id: "datalayer_order", group: "tracking", label: "dataLayer before GTM", status: "info",
      detail: early
        ? "dataLayer is initialised before the GTM snippet, so values pushed early (like consent defaults) are available when the container loads."
        : "No dataLayer initialisation before the GTM snippet. That's fine unless you need to push values (such as consent defaults) before the container loads.",
    });
  }

  /* ---------------- consent ---------------- */
  const cmps = CMPS.filter(([, re]) => re.test(stripped)).map(([n]) => n);
  const cmpNames = cmps.length > 1 ? cmps.filter((n) => !n.startsWith("TCF-compatible")) : cmps;
  add({
    id: "cmp", group: "consent", label: "Consent banner (CMP)",
    status: cmpNames.length ? "pass" : tagsPresent ? "warn" : "info",
    detail: cmpNames.length
      ? `Consent management platform detected: ${cmpNames.join(", ")}. We can see its script, not whether the banner actually shows or is configured correctly.`
      : tagsPresent
        ? "Tracking tags are present but no known consent banner was found in the raw HTML. If you have EU/UK visitors, this is a compliance and data-quality risk (it may also be loaded by JavaScript we can't see)."
        : "No consent banner detected. No tracking tags were detected either, so it may not be needed.",
    evidence: cmpNames.join(", ") || undefined,
  });

  const defaultRe = /['"]consent['"]\s*,\s*['"]default['"]\s*,\s*\{([^}]{0,2000})\}/g;
  const defaults = [...stripped.matchAll(defaultRe)];
  const defaultText = defaults.map((m) => m[1]).join(" ");
  const hasDefault = defaults.length > 0 || /['"]consent['"]\s*,\s*['"]default['"]/.test(stripped);
  const v2 = /ad_user_data/.test(defaultText) && /ad_personalization/.test(defaultText);
  const firstDefault = stripped.search(/['"]consent['"]\s*,\s*['"]default['"]/);
  const firstTag = stripped.search(/googletagmanager\.com\/(?:gtm|gtag)/i);
  const lateDefault = hasDefault && firstTag !== -1 && firstDefault > firstTag;

  if (hasDefault) {
    add({
      id: "consent_mode", group: "consent", label: "Google Consent Mode",
      status: !v2 ? "warn" : lateDefault ? "warn" : "pass",
      detail: !v2
        ? "A consent default command exists but doesn't set ad_user_data and ad_personalization. That's Consent Mode v1; Google now expects v2 for EU/UK ad measurement."
        : lateDefault
          ? "Consent Mode v2 defaults are set, but after the Google tag loads in the HTML. Defaults must run before tags to be reliable."
          : "Consent Mode v2 default command found, including ad_user_data and ad_personalization.",
      evidence: ev(defaultText.replace(/\s+/g, " "), 160) || undefined,
    });
  } else if (cmpNames.length) {
    add({
      id: "consent_mode", group: "consent", label: "Google Consent Mode", status: "info",
      detail: "A CMP is present but no inline consent default command was found. It may be set by the CMP template inside GTM; we can't confirm without running the page.",
    });
  } else if (tagsPresent) {
    add({
      id: "consent_mode", group: "consent", label: "Google Consent Mode", status: "warn",
      detail: "Tracking tags are present but there is no Consent Mode default and no consent banner in the HTML. For EU/UK traffic this typically means tags fire before consent and Google ad features may be limited.",
    });
  } else {
    add({ id: "consent_mode", group: "consent", label: "Google Consent Mode", status: "info", detail: "No tracking tags detected, so Consent Mode isn't applicable here." });
  }

  /* ---------------- platform hints ---------------- */
  const platformHints = PLATFORMS.filter(([, test]) => test(stripped, meta.headers)).map(([n]) => n);

  return {
    url: meta.url,
    finalUrl: meta.finalUrl,
    fetchedAt: new Date().toISOString(),
    httpStatus: meta.httpStatus,
    responseMs: meta.responseMs,
    htmlBytes: meta.htmlBytes,
    score: computeScores(checks),
    likelyClientRendered,
    platformHints,
    checks,
  };
}

/* ------------------------------------------------------------------ */
/* 7. scanUrl                                                          */
/* ------------------------------------------------------------------ */

export async function scanUrl(input: string): Promise<ScanResult> {
  const start = normalizeUrl(input);
  const t0 = Date.now();
  const page = await fetchChain(start, { timeoutMs: TOTAL_TIMEOUT_MS, maxBytes: MAX_HTML_BYTES, requireHtml: true });
  const responseMs = Date.now() - t0;

  const origin = new URL(page.finalUrl).origin;
  const [robotsTxt, sitemap] = await Promise.all([probe(`${origin}/robots.txt`), probe(`${origin}/sitemap.xml`)]);

  return analyzeHtml(page.body, {
    url: start.href,
    finalUrl: page.finalUrl,
    httpStatus: page.status,
    responseMs,
    htmlBytes: page.bytes,
    headers: page.headers,
    redirects: page.redirects,
    truncated: page.truncated,
    robotsTxt,
    sitemap,
  });
}

