/**
 * Browser runner: one Capture per target, three consent scenarios
 * (none / accept / reject), each in a FRESH browser context.
 *
 * Per scenario:
 *   load start page -> settle -> [pre: screenshot, dataLayer, gtag consent,
 *   cookies] -> consent action (none: nothing) -> phase "post" -> settle ->
 *   [post: screenshot, dataLayer, gtag consent, cookies] -> more pages
 *   (accept: up to maxPages in total from collectLinks; none/reject: the
 *   start page + 1) -> conversion discovery + funnel walk (accept only by
 *   default; `walkInReject` adds the same walk in reject).
 *
 * Phase "post" is also set in scenario "none" (after the point where a
 * visitor would decide) so the three scenarios line up on the same timeline.
 *
 * Safety: the browser runs behind the SSRF guard proxy (every connection,
 * including redirect hops and WebSockets), plus route-level checks in
 * capture.ts. No stealth: the UA is the browser's own ("HeadlessChrome" ->
 * "Chrome") plus a StrativraScanner token so site owners can see who visited. A bot wall aborts
 * the run as bot_protection; there is never a bypass attempt.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright-core";
import type {
  BannerOutcome,
  Capture,
  ConversionPoint,
  CookieRecord,
  DataLayerPush,
  FunnelStep,
  PageVisit,
  Scenario,
  ScenarioRun,
  Screenshot,
} from "../types.ts";
import { assertPublicUrl, bareHost, createHostChecker, normalizeUrl, SsrfError, type HostChecker } from "../core/net/ssrf.ts";
import { startGuardProxy } from "../core/net/guard-proxy.ts";
import { attachRecorder, snapshotCookies, type Recorder } from "./capture.ts";
import { handleBanner, installAutoconsent } from "./consent.ts";
import { icsToConsent, INIT_SCRIPT, readPageState } from "./init-script.ts";
import { collectLinks, discoverConversionPoints } from "./discover.ts";
import { walkFunnels } from "./walk.ts";

export const DEFAULT_CHROMIUM = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";

export interface BrowserDeps {
  discoverConversionPoints(page: Page, opts: { siteHost: string }): Promise<ConversionPoint[]>;
  walkFunnels(
    page: Page,
    points: ConversionPoint[],
    ctx: { scenario: Scenario; startedAt: number; siteHost: string },
  ): Promise<{ steps: FunnelStep[]; visits: PageVisit[] }>;
  collectLinks(page: Page, siteHost: string, max: number): Promise<string[]>;
}

export interface RunOptions {
  executablePath?: string;
  /** Egress region label printed in the report. */
  region: string;
  /** Pages per scenario "accept", start page included. Default 5. */
  maxPages?: number;
  /** Total budget for the whole run. Default 120000. */
  timeoutMs?: number;
  /** Fixed settle window after load. Default 6000 (link pages use half). */
  settleMs?: number;
  screenshotDir?: string;
  /** TEST ONLY: allow 127.0.0.1 / ::1 / localhost targets (other private ranges stay blocked). */
  allowPrivate?: boolean;
  /** Run the funnel walk in "reject" as well. Default false. */
  walkInReject?: boolean;
  /** Max requests per scenario before "limit" blocks. Default 3000. */
  maxRequests?: number;
  /** Upstream egress proxy (CONNECT), e.g. a sandbox proxy. Default none. */
  upstreamProxy?: string;
  /** SANDBOX ONLY: with upstreamProxy, names that fail local DNS are not blocked (hostname checks still apply). */
  dnsFailure?: "block" | "allow";
  /** Override discovery / walk / links (tests). Defaults: discover.ts + walk.ts. */
  deps?: Partial<BrowserDeps>;
}

const SCENARIOS: Scenario[] = ["none", "accept", "reject"];
const VIEWPORT = { width: 1366, height: 900 };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Ported from site/src/lib/scan.ts PLATFORMS. */
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

export function detectPlatforms(html: string, headers: Record<string, string>): string[] {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
  return PLATFORMS.filter(([, t]) => t(stripped, headers)).map(([n]) => n);
}

const BOT_STATUSES = [401, 403, 429, 503];
const BOT_MARKERS =
  /cf-chl|challenge-platform|cf_chl_opt|just a moment|attention required|captcha|verify you are human|are you a robot|px-captcha|_incapsula_resource|ddos-guard|pardon our interruption|access denied|request unsuccessful/i;
const BOT_TITLE = /^\s*(just a moment|attention required|verify you are human|are you a robot|pardon our interruption|ddos-guard|security check)/i;

/** True when the response is a bot-protection wall (never bypassed). */
export function isBotWall(status: number | null, title: string, html: string): boolean {
  if (status !== null && BOT_STATUSES.includes(status) && (BOT_MARKERS.test(title) || BOT_MARKERS.test(html.slice(0, 200_000))))
    return true;
  if (BOT_TITLE.test(title)) return true;
  return /cf-chl-|\/cdn-cgi\/challenge-platform\//.test(html.slice(0, 200_000)) && /just a moment|checking your browser/i.test(html);
}

function loadDeps(over: Partial<BrowserDeps> | undefined): BrowserDeps {
  return {
    discoverConversionPoints: over?.discoverConversionPoints ?? discoverConversionPoints,
    walkFunnels: over?.walkFunnels ?? walkFunnels,
    collectLinks: over?.collectLinks ?? collectLinks,
  };
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

interface RunState {
  deadline: number;
  timedOut: boolean;
  capture: Capture;
  checker: HostChecker;
  opts: Required<Pick<RunOptions, "maxPages" | "settleMs">> & RunOptions;
  deps: BrowserDeps;
  siteHost: string;
  userAgent: string;
  pagesSeen: Set<string>;
  pointIds: Set<string>;
}

function timeLeft(st: RunState): number {
  return st.deadline - Date.now();
}

async function settle(page: Page, st: RunState, settleMs: number): Promise<void> {
  const cap = (ms: number) => Math.max(0, Math.min(ms, timeLeft(st) - 1000));
  await page.waitForLoadState("load", { timeout: cap(20_000) }).catch(() => {});
  await sleep(cap(settleMs));
  // Best effort only: long-polling sites never go idle.
  await page.waitForLoadState("networkidle", { timeout: cap(3000) }).catch(() => {});
}

function addVisit(st: RunState, v: PageVisit) {
  if (st.pagesSeen.has(v.url)) return;
  st.pagesSeen.add(v.url);
  st.capture.pages.push(v);
}

async function screenshot(page: Page, st: RunState, scenario: Scenario, name: string, caption: string, run: ScenarioRun) {
  const dir = st.opts.screenshotDir;
  if (!dir) return;
  const key = `${scenario}-${name}.jpg`;
  try {
    await page.screenshot({ path: path.join(dir, key), type: "jpeg", quality: 60, timeout: 5000 });
    const shot: Screenshot = { key, caption, pageUrl: page.url(), scenario };
    run.screenshots.push(shot);
  } catch (e) {
    run.errors.push(`screenshot ${key}: ${(e as Error).message.split("\n")[0]}`);
  }
}

async function drain(page: Page, st: RunState, rec: Recorder, run: ScenarioRun, startedAt: number) {
  const s = await readPageState(page);
  if (!s) return null;
  const pageUrl = page.url();
  for (const e of s.dataLayer) {
    const push: DataLayerPush = { scenario: run.scenario, phase: rec.phase, ts: e.t - startedAt, pageUrl, payload: e.p };
    run.dataLayer.push(push);
  }
  if (s.dropped) run.errors.push(`dataLayer: ${s.dropped} pushes over the cap were not recorded on ${pageUrl}`);
  return s;
}

function mergeCookies(run: ScenarioRun, list: CookieRecord[]) {
  run.cookies.push(...list);
}

async function goto(page: Page, url: string, st: RunState): Promise<{ resp: Response | null; error?: string }> {
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(1000, Math.min(30_000, timeLeft(st) - 1000)) });
    return { resp };
  } catch (e) {
    return { resp: null, error: (e as Error).message.split("\n")[0] };
  }
}

async function runScenario(browser: Browser, scenario: Scenario, startUrl: URL, st: RunState): Promise<ScenarioRun> {
  const run: ScenarioRun = { scenario, banner: scenario === "none" ? "not_applicable" : "no_banner", requests: [], dataLayer: [], cookies: [], screenshots: [], errors: [] };
  const context: BrowserContext = await browser.newContext({
    viewport: VIEWPORT,
    locale: "en-US",
    userAgent: st.userAgent,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  const startedAt = Date.now();
  let rec: Recorder | null = null;
  try {
    await context.addInitScript({ content: INIT_SCRIPT });
    if (scenario !== "none") await installAutoconsent(context, scenario);
    rec = await attachRecorder(context, scenario, { checker: st.checker, startedAt, siteHost: st.siteHost, maxRequests: st.opts.maxRequests });
    run.requests = rec.requests;
    const page = await context.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    rec.setPageUrl(startUrl.href);

    /* ---- start page ---- */
    const first = await goto(page, startUrl.href, st);
    if (!first.resp) {
      run.errors.push(`start page: ${first.error ?? "no response"}`);
      if (st.capture.scenarios.length === 0 && !st.capture.aborted)
        st.capture.aborted = { reason: st.timedOut ? "timeout" : "unreachable", detail: first.error ?? "no response" };
      return run;
    }
    const status = first.resp.status();
    const ctype = first.resp.headers()["content-type"] ?? "";
    addVisit(st, { url: page.url(), status, via: "start", title: await page.title().catch(() => undefined) });
    if (ctype && !/html/i.test(ctype)) {
      st.capture.aborted ??= { reason: "not_html", detail: `content-type ${ctype}` };
      return run;
    }
    await settle(page, st, st.opts.settleMs);
    const title = await page.title().catch(() => "");
    const html = await page.content().catch(() => "");
    if (isBotWall(status, title, html)) {
      run.banner = "blocked_by_bot_protection";
      st.capture.aborted ??= { reason: "bot_protection", detail: `HTTP ${status}${title ? `, "${title.slice(0, 80)}"` : ""}` };
      await screenshot(page, st, scenario, "start-blocked", "Bot protection page", run);
      return run;
    }
    if (!st.capture.finalUrl) st.capture.finalUrl = page.url();
    if (st.capture.platformHints.length === 0) st.capture.platformHints = detectPlatforms(html, first.resp.headers());

    /* ---- pre phase ---- */
    await screenshot(page, st, scenario, "start-pre", scenario === "none" ? "Start page, no choice made" : "Start page before the consent choice (banner state)", run);
    const pre = await drain(page, st, rec, run, startedAt);
    const consent: NonNullable<ScenarioRun["gtagConsent"]> = {};
    const preC = icsToConsent(pre?.ics ?? null);
    if (preC) consent.pre = preC;
    mergeCookies(run, await snapshotCookies(context, scenario, "pre", st.siteHost));

    /* ---- consent action ---- */
    if (scenario !== "none") {
      const r = await handleBanner(page, scenario, { beforeAction: () => rec?.setPhase("post") }).catch((e: Error) => {
        run.errors.push(`banner: ${e.message.split("\n")[0]}`);
        return { outcome: "not_clickable" as BannerOutcome, cmp: undefined, method: undefined };
      });
      run.banner = r.outcome;
      if (r.cmp) run.cmp = r.cmp;
      if (r.method) run.bannerMethod = r.method;
    }
    rec.setPhase("post");
    await settle(page, st, st.opts.settleMs);
    await screenshot(page, st, scenario, "start-post", `Start page after "${scenario}"`, run);
    const post = await drain(page, st, rec, run, startedAt);
    const postC = icsToConsent(post?.ics ?? null);
    if (postC) consent.post = postC;
    if (consent.pre || consent.post) run.gtagConsent = consent;

    /* ---- discovery on the start page (accept, or reject with walkInReject) ---- */
    const walkHere = scenario === "accept" || (scenario === "reject" && st.opts.walkInReject === true);
    const points: ConversionPoint[] = [];
    const discover = async () => {
      if (!walkHere || !st.deps.discoverConversionPoints) return;
      try {
        for (const p of await st.deps.discoverConversionPoints(page, { siteHost: st.siteHost })) {
          if (!points.some((x) => x.id === p.id)) points.push(p);
        }
      } catch (e) {
        run.errors.push(`discover: ${(e as Error).message.split("\n")[0]}`);
      }
    };
    await discover();

    /* ---- more pages ---- */
    const extra = scenario === "accept" ? Math.max(0, st.opts.maxPages - 1) : 1;
    let links: string[] = [];
    try {
      links = await st.deps.collectLinks(page, st.siteHost, extra);
    } catch (e) {
      run.errors.push(`collectLinks: ${(e as Error).message.split("\n")[0]}`);
    }
    for (const link of links.slice(0, extra)) {
      if (timeLeft(st) < st.opts.settleMs + 5000) {
        run.errors.push("time budget: skipped remaining pages");
        break;
      }
      rec.setPageUrl(link);
      const r = await goto(page, link, st);
      addVisit(st, { url: r.resp ? page.url() : link, status: r.resp?.status() ?? null, via: "link", title: await page.title().catch(() => undefined) });
      if (!r.resp) {
        run.errors.push(`page ${link}: ${r.error}`);
        continue;
      }
      await settle(page, st, Math.round(st.opts.settleMs / 2));
      await drain(page, st, rec, run, startedAt);
      await discover();
    }

    /* ---- funnel walk ---- */
    if (walkHere && st.deps.walkFunnels && points.length && timeLeft(st) > 10_000) {
      try {
        const res = await st.deps.walkFunnels(page, points, { scenario, startedAt, siteHost: st.siteHost });
        for (const v of res.visits) addVisit(st, v);
        attachSteps(points, res.steps);
        await drain(page, st, rec, run, startedAt);
      } catch (e) {
        run.errors.push(`walk: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    if (scenario === "accept" || (st.capture.conversionPoints.length === 0 && points.length)) {
      for (const p of points) {
        if (st.pointIds.has(p.id)) continue;
        st.pointIds.add(p.id);
        st.capture.conversionPoints.push(p);
      }
    }
    mergeCookies(run, await snapshotCookies(context, scenario, "post", st.siteHost));
  } catch (e) {
    run.errors.push(st.timedOut ? "timeout" : `scenario: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    rec?.detach();
    await context.close().catch(() => {});
  }
  return run;
}

/**
 * FunnelStep has no point id in the contract. Attach by a runtime `pointId`
 * when the walker provides one, else by page URL, else to a single point.
 */
function attachSteps(points: ConversionPoint[], steps: FunnelStep[]) {
  if (!steps.length) return;
  if (points.some((p) => p.walk.length)) return; // the walker filled walk itself
  for (const s of steps) {
    const pid = (s as FunnelStep & { pointId?: string }).pointId;
    const target = (pid && points.find((p) => p.id === pid)) || (points.length === 1 ? points[0] : points.find((p) => p.pageUrl === s.pageUrl));
    if (target) target.walk.push(s);
  }
}

async function browserUserAgent(browser: Browser): Promise<string> {
  const ctx = await browser.newContext();
  try {
    const p = await ctx.newPage();
    const ua = await p.evaluate(() => navigator.userAgent);
    // Honest identification, like the raw-HTML scanner: real Chrome UA plus our token.
    return `${ua.replace("HeadlessChrome/", "Chrome/")} ${SCANNER_UA_TOKEN}`;
  } finally {
    await ctx.close().catch(() => {});
  }
}

export const SCANNER_UA_TOKEN = "StrativraScanner/1.0 (+https://strativra.com/scan)";

export async function runCapture(target: string, opts: RunOptions): Promise<Capture> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const capture: Capture = {
    target,
    finalUrl: "",
    region: opts.region,
    startedAt: new Date(t0).toISOString(),
    durationMs: 0,
    userAgent: "",
    pages: [],
    scenarios: [],
    conversionPoints: [],
    platformHints: [],
  };
  const finish = () => {
    capture.durationMs = Date.now() - t0;
    return capture;
  };
  const ssrfOpts = { allowPrivate: opts.allowPrivate === true };

  let startUrl: URL;
  try {
    startUrl = await assertPublicUrl(target, ssrfOpts);
  } catch (e) {
    const code = e instanceof SsrfError ? e.code : "invalid_url";
    if (code === "dns_failed" && opts.upstreamProxy && opts.dnsFailure === "allow") {
      startUrl = normalizeUrl(target, ssrfOpts);
    } else {
      capture.aborted = { reason: "unreachable", detail: code === "blocked_host" ? "blocked host (private or reserved address)" : (e as Error).message };
      return finish();
    }
  }

  if (opts.screenshotDir) await mkdir(opts.screenshotDir, { recursive: true });
  const checker = createHostChecker({ ...ssrfOpts, dnsFailure: opts.upstreamProxy ? opts.dnsFailure : "block" });
  const proxy = await startGuardProxy({ ...ssrfOpts, upstreamProxy: opts.upstreamProxy, dnsFailure: opts.dnsFailure });
  let browser: Browser | null = null;
  const st: RunState = {
    deadline: t0 + timeoutMs,
    timedOut: false,
    capture,
    checker,
    opts: { ...opts, maxPages: opts.maxPages ?? 5, settleMs: opts.settleMs ?? 6000 },
    deps: loadDeps(opts.deps),
    siteHost: bareHost(startUrl),
    userAgent: "",
    pagesSeen: new Set(),
    pointIds: new Set(),
  };
  const timer = setTimeout(() => {
    st.timedOut = true;
    browser?.close().catch(() => {});
  }, Math.max(1, timeoutMs - (Date.now() - t0)));
  try {
    browser = await chromium.launch({
      executablePath: opts.executablePath ?? process.env.CHROMIUM_PATH ?? DEFAULT_CHROMIUM,
      headless: true,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: ["--disable-quic", "--no-first-run", "--no-default-browser-check"],
    });
    st.userAgent = await browserUserAgent(browser);
    capture.userAgent = st.userAgent;
    for (const sc of SCENARIOS) {
      if (st.timedOut || timeLeft(st) <= 0) break;
      const run = await runScenario(browser, sc, startUrl, st);
      capture.scenarios.push(run);
      if (capture.aborted) break;
    }
  } catch (e) {
    if (!st.timedOut) capture.aborted ??= { reason: "unreachable", detail: `browser: ${(e as Error).message.split("\n")[0]}` };
  } finally {
    clearTimeout(timer);
    if (st.timedOut) capture.aborted ??= { reason: "timeout", detail: `run exceeded ${timeoutMs} ms` };
    await (browser as Browser | null)?.close().catch(() => {});
    await proxy.close().catch(() => {});
  }
  return finish();
}

