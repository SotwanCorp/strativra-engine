/**
 * SSRF guards: URL validation + IP classification + DNS-resolving checks.
 *
 * Ported from the instant scanner (`src/core/instant/scan.ts`, sections 2-3) with the
 * same block lists: IPv4 private / reserved ranges, IPv6 allow-list (only
 * global unicast 2000::/3 minus documentation, Teredo, 6to4).
 *
 * `allowPrivate` exists ONLY so tests can scan local fixtures. It allows
 * exactly the loopback host 127.0.0.1 / ::1 / localhost (any port). Every
 * other private range stays blocked even then, so tests can still prove that
 * e.g. a redirect to 127.0.0.2 or 169.254.169.254 is refused.
 */

import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export interface SsrfOptions {
  /** Test-only: allow 127.0.0.1, ::1 and localhost (nothing else private). */
  allowPrivate?: boolean;
}

export type SsrfErrorCode = "invalid_url" | "blocked_host" | "dns_failed";

export class SsrfError extends Error {
  code: SsrfErrorCode;
  constructor(code: SsrfErrorCode, message: string) {
    super(message);
    this.name = "SsrfError";
    this.code = code;
  }
}

const MAX_URL_LENGTH = 2048;

/** Exact hosts the test-only `allowPrivate` flag lets through. */
const TEST_LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Parse + validate a user-supplied URL (adds https:// when no scheme). */
export function normalizeUrl(input: string, opts: SsrfOptions = {}): URL {
  const raw = (input ?? "").trim();
  if (!raw) throw new SsrfError("invalid_url", "Enter a URL to scan.");
  if (raw.length > MAX_URL_LENGTH) throw new SsrfError("invalid_url", "That URL is too long.");
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) throw new SsrfError("invalid_url", "That URL contains invalid characters.");
  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  return validateParsedUrl(withScheme, opts);
}

export function validateParsedUrl(href: string, opts: SsrfOptions = {}): URL {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    throw new SsrfError("invalid_url", "That doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new SsrfError("invalid_url", "Only http and https URLs can be scanned.");
  if (u.username || u.password) throw new SsrfError("invalid_url", "URLs with credentials are not allowed.");
  const loopbackTest = opts.allowPrivate === true && TEST_LOOPBACK.has(bareHost(u));
  if (u.port && u.port !== "80" && u.port !== "443" && !loopbackTest)
    throw new SsrfError("invalid_url", "Only the standard ports 80 and 443 are allowed.");
  if (!u.hostname) throw new SsrfError("invalid_url", "That URL has no hostname.");
  u.hash = "";
  return u;
}

/** Hostname without IPv6 brackets or trailing dot, lowercased. */
export function bareHost(u: URL | string): string {
  const h = typeof u === "string" ? u : u.hostname;
  return h.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** Hostname-level (pre-DNS) block list. IP literals are classified directly. */
export function isBlockedHostname(host: string, opts: SsrfOptions = {}): boolean {
  const h = bareHost(host);
  if (opts.allowPrivate === true && TEST_LOOPBACK.has(h)) return false;
  if (net.isIP(h)) return isBlockedIp(h, opts);
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
export function isBlockedIp(ip: string, opts: SsrfOptions = {}): boolean {
  const bare = bareHost(ip);
  if (opts.allowPrivate === true && (bare === "127.0.0.1" || bare === "::1")) return false;
  const kind = net.isIP(bare);
  if (kind === 4) return isBlockedV4(bare);
  if (kind !== 6) return true;
  const g = expandV6(bare);
  if (!g) return true;
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true; // documentation
  return false;
}

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

export const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Resolve all addresses and reject if ANY is non-public. Returns the
 * validated addresses (callers that open sockets should connect to one of
 * these, which pins DNS and closes the rebinding gap).
 */
export async function assertPublicHost(
  host: string,
  opts: SsrfOptions & { resolver?: Resolver } = {},
): Promise<Array<{ address: string; family: number }>> {
  const h = bareHost(host);
  if (isBlockedHostname(h, opts)) throw new SsrfError("blocked_host", "That host can't be scanned.");
  const kind = net.isIP(h);
  if (kind) return [{ address: h, family: kind }];
  if (opts.allowPrivate === true && h === "localhost") return [{ address: "127.0.0.1", family: 4 }];
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await (opts.resolver ?? defaultResolver)(h);
  } catch {
    throw new SsrfError("dns_failed", "We couldn't resolve that domain name.");
  }
  if (!addrs.length) throw new SsrfError("dns_failed", "We couldn't resolve that domain name.");
  if (addrs.some((a) => isBlockedIp(a.address, opts))) throw new SsrfError("blocked_host", "That host can't be scanned.");
  return addrs;
}

/** Validate a URL string and its host's DNS. Throws SsrfError. */
export async function assertPublicUrl(url: string | URL, opts: SsrfOptions & { resolver?: Resolver } = {}): Promise<URL> {
  const u = typeof url === "string" ? normalizeUrl(url, opts) : validateParsedUrl(url.href, opts);
  await assertPublicHost(u.hostname, opts);
  return u;
}

export interface HostChecker {
  /** Resolves to null when allowed, or the reason it is blocked. */
  check(host: string): Promise<null | SsrfErrorCode>;
  /** Cached verdict without waiting (undefined when not checked yet). */
  peek(host: string): null | SsrfErrorCode | undefined;
}

/**
 * Cached host checker for per-request checks inside the browser layer.
 * `dnsFailure: "allow"` is a sandbox-only escape hatch for environments
 * where local DNS is unavailable and an upstream egress proxy resolves names
 * instead; hostname and IP-literal checks still apply. Default: block.
 */
export function createHostChecker(
  opts: SsrfOptions & { resolver?: Resolver; ttlMs?: number; dnsFailure?: "block" | "allow" } = {},
): HostChecker {
  const ttl = opts.ttlMs ?? 60_000;
  const cache = new Map<string, { at: number; verdict: null | SsrfErrorCode; pending?: Promise<null | SsrfErrorCode> }>();
  async function run(h: string): Promise<null | SsrfErrorCode> {
    try {
      await assertPublicHost(h, opts);
      return null;
    } catch (e) {
      const code = e instanceof SsrfError ? e.code : "dns_failed";
      if (code === "dns_failed" && opts.dnsFailure === "allow") return null;
      return code;
    }
  }
  return {
    peek(host) {
      const hit = cache.get(bareHost(host));
      if (!hit || hit.pending || Date.now() - hit.at > ttl) return undefined;
      return hit.verdict;
    },
    check(host) {
      const h = bareHost(host);
      const hit = cache.get(h);
      if (hit && hit.pending) return hit.pending;
      if (hit && Date.now() - hit.at <= ttl) return Promise.resolve(hit.verdict);
      const entry: { at: number; verdict: null | SsrfErrorCode; pending?: Promise<null | SsrfErrorCode> } = {
        at: Date.now(),
        verdict: "dns_failed",
      };
      entry.pending = run(h).then((v) => {
        entry.verdict = v;
        entry.at = Date.now();
        entry.pending = undefined;
        return v;
      });
      cache.set(h, entry);
      return entry.pending;
    },
  };
}
