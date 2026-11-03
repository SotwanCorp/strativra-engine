/**
 * Context-wide request recording + network safety layer.
 *
 * Recording: `context.on("request")` sees requests from every page, iframe
 * and popup of the context, and dedicated workers (Chromium). Service
 * workers are blocked at context creation (`serviceWorkers: "block"`), so
 * nothing bypasses routing through a SW.
 *
 * Safety via `context.route("**\/*")`, applied before a request leaves:
 *   (a) SSRF: the hostname is DNS-checked (cached) and private targets are
 *       aborted ("ssrf"). Redirect hops never reach `route` (Playwright
 *       limitation), so the runner also launches the browser behind the
 *       guard proxy (core/net/guard-proxy.ts) that checks every connection;
 *       redirect hops to blocked hosts are recorded here as "ssrf".
 *   (b) POST to a non-tracking destination: aborted ("form_submit");
 *       PUT/PATCH/DELETE: aborted ("unsafe_method").
 *   (c) payment endpoints (navigation or non-GET to Stripe/PayPal checkout,
 *       any non-GET to a /checkout path): aborted ("payment").
 *   (d) more than `maxRequests` requests: aborted ("limit").
 * Exception: one narrow, same-site add-to-cart POST shape (see
 * isSameSiteAddToCart) so the purchase walk can reach the checkout page.
 * Blocked requests are still recorded, with `blocked` set.
 *
 * Composition: page-level routes (e.g. the walk's guard) run first and hand
 * requests on with route.fallback(); this context route then decides with
 * continue/abort, so it is always the last word.
 */

import type { BrowserContext, Request, Route } from "playwright-core";
import type { BlockReason, CapturedRequest, ConsentPhase, CookieRecord, Scenario } from "../types.ts";
import { bareHost, type HostChecker } from "../core/net/ssrf.ts";

export const POST_DATA_CAP = 64 * 1024;

/** Hosts (suffix match) whose requests are tracking hits. */
const TRACKING_HOST_SUFFIXES = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "googleadservices.com",
  "doubleclick.net",
  "px.ads.linkedin.com",
  "analytics.tiktok.com",
  "bat.bing.com",
  "clarity.ms",
  "hotjar.com",
  "hotjar.io",
];
/** Host + path prefix pairs. */
const TRACKING_HOST_PATHS: Array<[RegExp, RegExp]> = [
  [/(^|\.)google\.[a-z.]+$/, /^\/(pagead|ccm)\//],
  [/(^|\.)facebook\.com$/, /^\/tr\/?/],
];

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith("." + suffix);
}

/** True for a known tracking destination, or a first-party GA-style collect path. */
export function isTrackingUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = bareHost(u);
  if (TRACKING_HOST_SUFFIXES.some((s) => hostMatches(host, s))) return true;
  if (TRACKING_HOST_PATHS.some(([h, p]) => h.test(host) && p.test(u.pathname))) return true;
  // First-party (sGTM / proxy) GA4 or UA collect endpoints.
  if (/(^|\/)(g\/)?collect\/?$/.test(u.pathname)) {
    const q = u.searchParams;
    if (q.has("tid") || (q.has("v") && (q.has("en") || q.has("t")))) return true;
  }
  return false;
}

const PAYMENT_HOSTS = ["checkout.stripe.com", "api.stripe.com", "paypal.com", "paypalobjects.com", "checkout.paddle.com", "pay.google.com"];

export function paymentBlock(raw: string, method: string, isNavigation: boolean): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = bareHost(u);
  const paymentHost = PAYMENT_HOSTS.some((s) => hostMatches(host, s));
  if (paymentHost && (isNavigation || method !== "GET")) return true;
  if (method !== "GET" && method !== "HEAD" && /\/checkout(s)?(\/|$)/i.test(u.pathname)) return true;
  return false;
}

/**
 * Approximate registrable domain without a public-suffix list: last two
 * labels, or last three for ccTLD second levels like co.uk / com.au.
 */
export function registrableDomain(host: string): string {
  const parts = bareHost(host).split(".");
  if (parts.length <= 2) return parts.join(".");
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const n = tld.length === 2 && sld.length <= 3 ? 3 : 2;
  return parts.slice(-n).join(".");
}

/**
 * Narrow, same-site-only allow-list for ONE add-to-cart POST during the
 * purchase walk (Shopify /cart/add(.js), WooCommerce wc-ajax=add_to_cart,
 * ?add-to-cart=<id>, admin-ajax.php action=woocommerce_add_to_cart).
 * Checkout / order / payment POSTs never match.
 */
export function isSameSiteAddToCart(raw: string, siteHost: string | undefined, postData?: string | null): boolean {
  if (!siteHost) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (registrableDomain(u.hostname) !== registrableDomain(siteHost)) return false;
  const p = u.pathname.toLowerCase();
  if (/\/(checkout|order|orders|payment|pay)(\/|\.|$)/.test(p)) return false;
  if (/(^|\/)cart\/add(\.js)?\/?$/.test(p)) return true; // Shopify (incl. locale prefixes)
  const q = u.searchParams;
  if (q.get("wc-ajax") === "add_to_cart") return true;
  if (/^\d+$/.test(q.get("add-to-cart") ?? "")) return true;
  if (/\/wp-admin\/admin-ajax\.php$/.test(p)) {
    const body = postData ?? "";
    if (/(^|&)action=woocommerce_add_to_cart(&|$)/.test(body) || /"action"\s*:\s*"woocommerce_add_to_cart"/.test(body)) return true;
  }
  return false;
}

/** Decide whether a request must be blocked (excluding SSRF + limit, handled by the recorder). */
export function safetyVerdict(
  raw: string,
  method: string,
  isNavigation: boolean,
  ctx: { siteHost?: string; postData?: string | null } = {},
): BlockReason | null {
  const m = method.toUpperCase();
  if (paymentBlock(raw, m, isNavigation)) return "payment";
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  if (isTrackingUrl(raw)) return null;
  if (m === "POST" && isSameSiteAddToCart(raw, ctx.siteHost, ctx.postData)) return null;
  if (m === "POST") return "form_submit";
  return "unsafe_method";
}

export interface RecorderOptions {
  checker: HostChecker;
  /** Start-page host, for the same-site add-to-cart allow-list. */
  siteHost?: string;
  maxRequests?: number;
  startedAt: number;
}

export interface Recorder {
  requests: CapturedRequest[];
  scenario: Scenario;
  phase: ConsentPhase;
  setPhase(p: ConsentPhase): void;
  /** Called by the runner when it navigates, used when a request has no frame. */
  setPageUrl(u: string): void;
  /** Stop recording (after the scenario ends). */
  detach(): void;
}

function frameTopUrl(req: Request, fallback: string): string {
  try {
    const f = req.frame();
    const p = f.page();
    if (p) return p.url();
  } catch {
    /* worker / detached */
  }
  return fallback;
}

/** Attach recording + safety routing to a fresh context for one scenario. */
export async function attachRecorder(context: BrowserContext, scenario: Scenario, opts: RecorderOptions): Promise<Recorder> {
  const max = opts.maxRequests ?? 3000;
  const byReq = new Map<Request, CapturedRequest>();
  let routed = 0;
  let seq = 0;
  let active = true;
  const rec: Recorder = {
    requests: [],
    scenario,
    phase: "pre",
    setPhase(p) {
      rec.phase = p;
    },
    setPageUrl(u) {
      pageUrl = u;
    },
    detach() {
      active = false;
      context.off("request", onRequest);
      context.off("requestfailed", onFailed);
    },
  };
  let pageUrl = "";

  function onRequest(req: Request) {
    if (!active) return;
    const url = req.url();
    if (!/^(https?|wss?):/i.test(url)) return;
    const method = req.method();
    const r: CapturedRequest = {
      id: `${scenario}-${++seq}`,
      scenario,
      phase: rec.phase,
      ts: Date.now() - opts.startedAt,
      pageUrl: frameTopUrl(req, pageUrl),
      url,
      method,
      resourceType: req.resourceType(),
    };
    if (method !== "GET" && isTrackingUrl(url)) {
      const body = req.postData();
      if (body != null) r.postData = body.length > POST_DATA_CAP ? body.slice(0, POST_DATA_CAP) : body;
    }
    rec.requests.push(r);
    byReq.set(req, r);
    // Redirect hops bypass route(); the guard proxy enforces them. Record the verdict here.
    if (req.redirectedFrom()) {
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        return;
      }
      opts.checker.check(host).then((v) => {
        if (v === "blocked_host") r.blocked = "ssrf";
      });
      const verdict = safetyVerdict(url, method, req.isNavigationRequest());
      if (verdict === "payment") r.blocked = r.blocked ?? "payment";
    }
  }
  context.on("request", onRequest);

  // A tag library that never loaded must not read as "the site sends nothing".
  function onFailed(req: Request) {
    const r = byReq.get(req);
    if (r && !r.blocked) r.failed = req.failure()?.errorText ?? "failed";
  }
  context.on("requestfailed", onFailed);

  async function onRoute(route: Route) {
    const req = route.request();
    const url = req.url();
    const mark = (reason: BlockReason) => {
      const r = byReq.get(req);
      if (r) r.blocked = reason;
    };
    if (!/^(https?|wss?):/i.test(url)) return route.continue();
    if (++routed > max) {
      mark("limit");
      return route.abort("blockedbyclient").catch(() => {});
    }
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      mark("ssrf");
      return route.abort("blockedbyclient").catch(() => {});
    }
    const ssrf = await opts.checker.check(host);
    if (ssrf === "blocked_host") {
      mark("ssrf");
      return route.abort("blockedbyclient").catch(() => {});
    }
    // dns_failed: let the browser fail naturally (the guard proxy blocks it too).
    let body: string | null = null;
    try {
      body = req.method() === "POST" ? req.postData() : null;
    } catch {
      body = null;
    }
    const verdict = safetyVerdict(url, req.method(), req.isNavigationRequest(), { siteHost: opts.siteHost, postData: body });
    if (verdict) {
      mark(verdict);
      return route.abort("blockedbyclient").catch(() => {});
    }
    return route.continue().catch(() => {});
  }
  await context.route("**/*", onRoute);
  return rec;
}

/** Registrable-ish base of a host: strips a leading "www.". */
function siteBase(host: string): string {
  return bareHost(host).replace(/^www\./, "");
}

/** Cookie names + domains only. Values are never read into our records. */
export async function snapshotCookies(
  context: BrowserContext,
  scenario: Scenario,
  phase: ConsentPhase,
  siteHost: string,
): Promise<CookieRecord[]> {
  const base = siteBase(siteHost);
  const seen = new Set<string>();
  const out: CookieRecord[] = [];
  let cookies: Array<{ name: string; domain: string }> = [];
  try {
    cookies = (await context.cookies()).map((c) => ({ name: c.name, domain: c.domain }));
  } catch {
    return out;
  }
  for (const c of cookies) {
    const d = c.domain.replace(/^\./, "").toLowerCase();
    const key = `${c.name}|${d}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const firstParty = d === base || d.endsWith("." + base) || base.endsWith("." + d);
    out.push({ scenario, phase, name: c.name, domain: d, firstParty });
  }
  return out;
}
