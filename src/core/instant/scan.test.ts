// Run: node --experimental-strip-types src/core/instant/scan.test.ts
import assert from "node:assert/strict";
import { analyzeHtml, isBlockedIp, isBlockedHostname, normalizeUrl, checkRateLimit } from "./scan.ts";
import type { AnalyzeMeta, Check } from "./scan.ts";

const meta = (over: Partial<AnalyzeMeta> = {}): AnalyzeMeta => ({
  url: "https://ex.com/", finalUrl: "https://ex.com/", httpStatus: 200, responseMs: 300, htmlBytes: 1000,
  headers: {}, redirects: [], truncated: false,
  robotsTxt: { status: 200, body: "User-agent: *\nAllow: /\nSitemap: https://ex.com/sitemap.xml" },
  sitemap: { status: 200, body: "<?xml version='1.0'?><urlset/>" }, ...over,
});
const get = (checks: Check[], id: string) => checks.find((c) => c.id === id);

// 1. Vite SPA shell + GTM
const spa = `<!doctype html><html><head><title>Vite + React App</title>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':1});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-ABC123');</script>
<script type="module" crossorigin src="/assets/index-Ab12.js"></script><meta name="generator" content="x"><script src="https://cdn.gpteng.co/gptengineer.js"></script></head>
<body><div id="root"></div></body></html>`;
{
  const r = analyzeHtml(spa, meta({ robotsTxt: { status: 200, body: "<!doctype html><html>" }, sitemap: { status: 200, body: "<!doctype html>" } }));
  assert.equal(r.likelyClientRendered, true);
  assert.equal(get(r.checks, "client_rendered")?.status, "fail");
  assert.equal(get(r.checks, "gtm")?.status, "pass");
  assert.equal(get(r.checks, "ga4")?.status, "info");
  assert.equal(get(r.checks, "robots_txt")?.status, "warn");
  assert.equal(get(r.checks, "consent_mode")?.status, "warn");
  assert.ok(r.platformHints.includes("Lovable") && r.platformHints.includes("Vite SPA"));
  console.log("SPA ok", r.score, r.platformHints);
}

// 2. Good SSR page: GA4 + consent v2 + Cookiebot
const body = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
const good = `<!doctype html><html lang="en"><head><title>Acme Plumbing Services in Leeds</title>
<meta name="description" content="${"Reliable plumbers in Leeds offering same-day repairs and boiler installs. ".repeat(1)}">
<link rel="canonical" href="https://ex.com/"><meta property="og:title" content="a"><meta property="og:description" content="b"><meta property="og:image" content="c">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"LocalBusiness"},{"@type":"WebSite"}]}</script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
gtag('consent','default',{'ad_storage':'denied','ad_user_data':'denied','ad_personalization':'denied','analytics_storage':'denied'});</script>
<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="x"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABCDE12345"></script>
<script>gtag('js',new Date());gtag('config','G-ABCDE12345');</script></head>
<body><h1>Plumbing in Leeds</h1><p>${body}</p></body></html>`;
{
  const r = analyzeHtml(good, meta());
  assert.equal(r.likelyClientRendered, false);
  for (const id of ["title", "meta_description", "h1", "canonical", "noindex", "lang", "open_graph", "json_ld", "consent_mode", "cmp", "ga4", "duplicates", "sitemap", "robots_txt"])
    assert.equal(get(r.checks, id)?.status, "pass", id);
  assert.equal(r.score.indexability, 100);
  assert.equal(r.score.tracking, 100);
  console.log("Good ok", r.score);
}

// 3. noindex + duplicate GA4
const bad = `<html lang="en"><head><title>Hello there friend</title><meta name="robots" content="noindex, follow">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-DUP0000001"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-DUP0000001"></script>
<script>gtag('config','G-DUP0000001');</script><!-- <script src="https://connect.facebook.net/en_US/fbevents.js"></script> --></head>
<body><h1>A</h1><h1>B</h1><p>${body}</p></body></html>`;
{
  const r = analyzeHtml(bad, meta({ headers: { "x-robots-tag": "noindex" } }));
  assert.equal(get(r.checks, "noindex")?.status, "fail");
  assert.equal(get(r.checks, "duplicates")?.status, "warn");
  assert.equal(get(r.checks, "h1")?.status, "warn");
  assert.equal(get(r.checks, "consent_mode")?.status, "warn");
  assert.equal(get(r.checks, "meta_pixel"), undefined); // commented out
  console.log("Bad ok", r.score);
}

// robots disallow-all
assert.equal(get(analyzeHtml(good, meta({ robotsTxt: { status: 200, body: "User-agent: *\nDisallow: /" } })).checks, "robots_txt")?.status, "fail");

// SSRF guards
for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "172.20.0.1", "192.168.1.1", "0.0.0.0", "224.0.0.1", "::1", "::", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::7f00:1"])
  assert.equal(isBlockedIp(ip), true, ip);
for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isBlockedIp(ip), false, ip);
for (const h of ["localhost", "a.local", "db.internal", "intranet", "2130706433", "127.0.0.1"]) assert.equal(isBlockedHostname(h), true, h);
assert.equal(normalizeUrl("example.com/x").href, "https://example.com/x");
for (const u of ["ftp://a.com", "http://u:p@a.com", "http://a.com:8080", "file:///etc/passwd", "javascript:alert(1)", "a".repeat(2100)])
  assert.throws(() => normalizeUrl(u), (e: any) => e.code === "invalid_url", u);
assert.equal(normalizeUrl("http://2130706433/").hostname, "127.0.0.1");
for (let i = 0; i < 10; i++) assert.ok(checkRateLimit("t").ok);
assert.equal(checkRateLimit("t").ok, false);
console.log("All scan self-checks passed");
