/**
 * Real-Chromium tests on local fixtures (127.0.0.1, allowPrivate: true).
 * Discovery / walk / links are stubbed here so this file tests only the
 * runner, capture, consent and safety layers.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Capture, ConversionPoint, FunnelStep, PageVisit, Scenario } from "../types.ts";
import { startFixtureServer, type FixtureServer } from "./fixtures/server.ts";
import { DEFAULT_CHROMIUM, isBotWall, runCapture, type BrowserDeps } from "./runner.ts";
import { handleBanner, installAutoconsent } from "./consent.ts";

const exe = process.env.CHROMIUM_PATH ?? DEFAULT_CHROMIUM;
const skip = existsSync(exe) ? false : `Chromium not found at ${exe}`;

let fx: FixtureServer;
let shots: string;
let cap: Capture;

function stubDeps(origin: string): BrowserDeps {
  return {
    collectLinks: async () => [`${origin}/contact.html`, `${origin}/about.html`, `${origin}/redirect`],
    discoverConversionPoints: async (page: Page): Promise<ConversionPoint[]> =>
      page.url().includes("contact")
        ? [{ id: "lead-contact", type: "lead", pageUrl: page.url(), label: "Contact form (3 fields)", selector: "#contact", detectedBy: "generic", confidence: 0.9, walk: [] }]
        : [],
    walkFunnels: async (page: Page, points: ConversionPoint[], ctx: { scenario: Scenario; startedAt: number; siteHost: string }) => {
      // Simulates a buggy walker that submits: the network layer must stop it.
      await page.goto(points[0].pageUrl);
      await page.evaluate(() => (document.getElementById("contact") as HTMLFormElement).submit()).catch(() => {});
      await page.waitForTimeout(500);
      const step: FunnelStep = { name: "form_start", action: "focused name field", ok: true, pageUrl: points[0].pageUrl, ts: Date.now() - ctx.startedAt, scenario: ctx.scenario };
      const visit: PageVisit = { url: points[0].pageUrl, status: 200, via: "funnel" };
      return { steps: [step], visits: [visit] };
    },
  };
}

before(async () => {
  if (skip) return;
  fx = await startFixtureServer();
  shots = mkdtempSync(path.join(tmpdir(), "strv-shots-"));
  cap = await runCapture(`${fx.origin}/`, {
    region: "test",
    allowPrivate: true,
    settleMs: 600,
    maxPages: 4,
    timeoutMs: 90_000,
    screenshotDir: shots,
    deps: stubDeps(fx.origin),
  });
});

after(async () => {
  if (skip) return;
  await fx.close();
  rmSync(shots, { recursive: true, force: true });
});

const scen = (s: Scenario) => cap.scenarios.find((x) => x.scenario === s)!;
const gaHits = (s: Scenario) => scen(s).requests.filter((r) => r.url.includes("/g/collect"));

test("runs three fresh scenarios with banner outcomes", { skip }, () => {
  assert.equal(cap.aborted, undefined, JSON.stringify(cap.aborted));
  assert.deepEqual(cap.scenarios.map((s) => s.scenario), ["none", "accept", "reject"]);
  assert.equal(scen("none").banner, "not_applicable");
  assert.equal(scen("accept").banner, "clicked", scen("accept").errors.join("; "));
  assert.equal(scen("reject").banner, "clicked", scen("reject").errors.join("; "));
  assert.ok(scen("accept").bannerMethod);
  assert.doesNotMatch(cap.userAgent, /HeadlessChrome/);
  assert.match(cap.userAgent, /Chrome\/\d+/);
  assert.deepEqual(cap.platformHints, ["WordPress"]);
  assert.equal(cap.finalUrl, `${fx.origin}/`);
});

test("GA4-like hits are recorded with scenario, phase and consent signal", { skip }, () => {
  const pre = gaHits("accept").filter((r) => r.phase === "pre");
  const post = gaHits("accept").filter((r) => r.phase === "post");
  assert.ok(pre.some((r) => /en=page_view/.test(r.url) && /gcs=G100/.test(r.url)), "pre-consent page_view denied");
  assert.ok(post.some((r) => /en=consent_granted/.test(r.url) && /gcs=G111/.test(r.url)), "post-consent granted hit");
  assert.ok(post.every((r) => r.ts >= pre[0].ts));
  assert.ok(pre[0].postData?.includes("en=page_view"), "tracking POST body kept");
  assert.ok(!gaHits("none").some((r) => /G111/.test(r.url)), "no granted hit without a choice");
  assert.ok(gaHits("reject").some((r) => /en=consent_denied/.test(r.url) && r.phase === "post"));
  for (const s of cap.scenarios) for (const r of s.requests) assert.ok(r.id.startsWith(s.scenario + "-"));
});

test("contact form POST, lead XHR and checkout POST are blocked and never reach the server", { skip }, () => {
  assert.equal(fx.hits.filter((h) => h.url.startsWith("/submit")).length, 0);
  assert.equal(fx.hits.filter((h) => h.url.startsWith("/api/lead")).length, 0);
  assert.equal(fx.hits.filter((h) => h.url.startsWith("/cart/checkout")).length, 0);
  const all = cap.scenarios.flatMap((s) => s.requests);
  assert.ok(all.some((r) => r.url.endsWith("/submit") && r.blocked === "form_submit"), "form submit recorded as blocked");
  assert.ok(all.some((r) => r.url.endsWith("/api/lead") && r.blocked === "form_submit"));
  assert.ok(all.some((r) => r.url.endsWith("/cart/checkout") && r.blocked === "payment"));
  assert.ok(all.filter((r) => r.blocked).every((r) => r.postData === undefined), "no bodies kept for blocked non-tracking requests");
});

test("redirect to a private address is blocked (secret server never reached)", { skip }, () => {
  assert.equal(fx.secretHits.length, 0);
  const acc = scen("accept").requests;
  assert.ok(acc.some((r) => r.url.startsWith(fx.secretOrigin) && r.blocked === "ssrf"), "redirect hop recorded as ssrf");
});

test("dataLayer copies are redacted; gtag consent per phase; cookies without values", { skip }, () => {
  const meta = scen("accept").dataLayer.find((d) => (d.payload as { event?: string }).event === "page_meta");
  assert.ok(meta);
  const p = meta.payload as Record<string, unknown>;
  assert.equal(p.user_email, "[email]");
  assert.match(String(p.phone), /^\[digits:/);
  assert.equal(p.order, 42);
  assert.ok(scen("accept").dataLayer.some((d) => (d.payload as { event?: string }).event === "consent_update" && d.phase === "post"));
  assert.ok(scen("accept").dataLayer.some((d) => (d.payload as { event?: string }).event === "contact_view"), "per-page reads");
  assert.equal(scen("accept").gtagConsent?.pre?.analytics_storage, "denied");
  assert.equal(scen("accept").gtagConsent?.post?.analytics_storage, "granted");
  assert.equal(scen("reject").gtagConsent?.post?.ad_storage, "denied");
  const ck = scen("accept").cookies.find((c) => c.name === "fx_consent" && c.phase === "post");
  assert.ok(ck);
  assert.equal(ck.firstParty, true);
  assert.deepEqual(Object.keys(ck).sort(), ["domain", "firstParty", "name", "phase", "scenario"]);
  assert.ok(!scen("none").cookies.some((c) => c.name === "fx_consent"));
});

test("pages, conversion points with walk, screenshots", { skip }, () => {
  const urls = cap.pages.map((p) => p.url);
  assert.ok(urls.includes(`${fx.origin}/`));
  assert.ok(urls.includes(`${fx.origin}/contact.html`));
  assert.ok(urls.includes(`${fx.origin}/about.html`));
  assert.equal(cap.conversionPoints.length, 1);
  assert.equal(cap.conversionPoints[0].walk.length, 1);
  for (const s of cap.scenarios) {
    assert.ok(s.screenshots.some((x) => x.key === `${s.scenario}-start-pre.jpg`));
    for (const x of s.screenshots) assert.ok(existsSync(path.join(shots, x.key)));
  }
  // none/reject visit only the start page + 1.
  const noneDocs = scen("none").requests.filter((r) => r.resourceType === "document").map((r) => r.url);
  assert.ok(!noneDocs.some((u) => u.endsWith("/about.html")));
});

test("bot protection aborts the run without bypass", { skip }, async () => {
  const c = await runCapture(`${fx.origin}/bot`, { region: "test", allowPrivate: true, settleMs: 200, timeoutMs: 30_000 });
  assert.equal(c.aborted?.reason, "bot_protection");
  assert.equal(c.scenarios.length, 1);
  assert.equal(c.scenarios[0].banner, "blocked_by_bot_protection");
  assert.equal(isBotWall(200, "Welcome", "<p>please solve the captcha in the form</p>"), false);
});

test("private start URLs are refused before any browser work", { skip }, async () => {
  const a = await runCapture(`${fx.secretOrigin}/`, { region: "test", allowPrivate: true });
  assert.equal(a.aborted?.reason, "unreachable");
  const b = await runCapture(`${fx.origin}/`, { region: "test" });
  assert.equal(b.aborted?.reason, "unreachable");
  const c = await runCapture("http://169.254.169.254/latest/meta-data", { region: "test", allowPrivate: true });
  assert.equal(c.aborted?.reason, "unreachable");
  assert.equal(fx.secretHits.length, 0);
});

test("total timeout is enforced and the browser is closed", { skip }, async () => {
  const t = Date.now();
  const c = await runCapture(`${fx.origin}/`, { region: "test", allowPrivate: true, settleMs: 5000, timeoutMs: 3000, deps: stubDeps(fx.origin) });
  assert.ok(Date.now() - t < 10_000);
  assert.equal(c.aborted?.reason, "timeout");
});

/* ---------------- consent.ts directly ---------------- */

let browser: Browser;
before(async () => {
  if (!skip) browser = await chromium.launch({ executablePath: exe, headless: true });
});
after(async () => {
  await browser?.close();
});

for (const [action, choice] of [["accept", "1"], ["reject", "0"]] as const) {
  test(`autoconsent bridge: ${action} on a known CMP rule`, { skip }, async () => {
    const ctx = await browser.newContext();
    await installAutoconsent(ctx, action);
    const page = await ctx.newPage();
    await page.goto(`${fx.origin}/cmp.html`);
    const r = await handleBanner(page, action);
    assert.equal(r.outcome, "clicked");
    assert.equal(r.method, "autoconsent");
    assert.ok(r.cmp);
    assert.equal(await page.evaluate(() => (window as unknown as { __fxChoice?: string }).__fxChoice), choice);
    await ctx.close();
  });
}

test("fallback clicks a text-matched banner button; no banner elsewhere", { skip }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${fx.origin}/`);
  const r = await handleBanner(page, "reject", { detectMs: 0 });
  assert.deepEqual([r.outcome, r.method], ["clicked", "fallback"]);
  assert.equal(await page.isVisible("#cookie-banner"), false);
  await page.goto(`${fx.origin}/about.html`);
  assert.equal((await handleBanner(page, "accept", { detectMs: 0 })).outcome, "no_banner");
  await ctx.close();
});

test("fallback never clicks danger labels or buttons in forms with inputs", { skip }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${fx.origin}/about.html`);
  await page.setContent(`
    <div id="cookie-consent" style="position:fixed;bottom:0">
      <p>We use cookies.</p>
      <form onsubmit="window.__sub=1;return false"><input name="email"><button type="button" onclick="window.__clicked=1">Accept</button></form>
      <button type="button" onclick="window.__clicked=2">Subscribe</button>
    </div>`);
  const r = await handleBanner(page, "accept", { detectMs: 0 });
  assert.equal(r.outcome, "not_clickable");
  assert.equal(await page.evaluate(() => (window as unknown as { __clicked?: number }).__clicked), undefined);
  await ctx.close();
});
