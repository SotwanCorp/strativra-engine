/**
 * End to end: the unpacked extension (out/extension-e2e, built by `npm run test:extension`) in
 * headless Chromium, driven through its real side panel page, against the engine's local fixture
 * sites. A local node:http server stands in for the platform API (strativra-api/v1) and checks what
 * the extension sends: Bearer key, gzip, JSON shape (the engine's own parseCaptureUpload), caps.
 * No live sites.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { startFixtureServer, type FixtureServer } from "../../browser/fixtures/server.ts";
import { decodeAll } from "../../core/decode/index.ts";
import { parseCaptureUpload } from "../../core/upload.ts";
import type { CapturedRequest } from "../../types.ts";
import type { UploadEnvelope } from "../lib/build.ts";
import { keyChecksum } from "../lib/key.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXT = path.join(ROOT, "out/extension-e2e");
const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const SHOP = fileURLToPath(new URL("../../browser/discover-fixtures/shop/", import.meta.url));
const skip = !existsSync(CHROME) ? `Chromium not found at ${CHROME}` : !existsSync(path.join(EXT, "manifest.json")) ? "run `npm run test:extension` (builds out/extension-e2e)" : false;

const RANDOM = "E2eTestKey0123456789abcdefABCDEF";
const KEY = `strv_live_${RANDOM}${keyChecksum(RANDOM)}`;

/* ------------------------- mock platform API ------------------------- */

interface Upload {
  auth: string;
  encoding: string;
  contentType: string;
  gzBytes: number;
  env: UploadEnvelope;
}

interface Platform {
  origin: string;
  uploads: Upload[];
  scans: Array<{ auth: string; idem: string; body: { url?: string } }>;
  problems: string[];
  close(): Promise<void>;
}

async function startPlatform(): Promise<Platform> {
  const uploads: Upload[] = [];
  const scans: Platform["scans"] = [];
  const problems: string[] = [];
  const polls = new Map<string, number>();
  let origin = "";
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = req.url ?? "/";
      const send = (status: number, body: unknown, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      const problem = (status: number, code: string, detail: string) => {
        problems.push(`${code}: ${detail}`);
        send(status, { type: "about:blank", title: code, status, code, detail }, "application/problem+json");
      };
      if (url.startsWith("/api/") && req.headers.authorization !== `Bearer ${KEY}`) return problem(401, "unauthorized", "bad key");
      if (req.method === "POST" && url === "/api/v1/captures") {
        if (req.headers["content-encoding"] !== "gzip") return problem(415, "unsupported_encoding", String(req.headers["content-encoding"]));
        if (!String(req.headers["content-type"]).startsWith("application/json")) return problem(415, "unsupported_media_type", String(req.headers["content-type"]));
        if (raw.byteLength > 2 * 1024 * 1024) return problem(413, "payload_too_large", "over 2 MB");
        let env: UploadEnvelope;
        try {
          env = JSON.parse(gunzipSync(raw).toString("utf8"));
          parseCaptureUpload(env); // the engine's validator: throws on a bad shape or over 5,000 requests
        } catch (e) {
          return problem(400, "invalid_capture", (e as Error).message);
        }
        for (const run of env.capture.scenarios) for (const r of run.requests) if (r.postData && Buffer.byteLength(r.postData) > 64 * 1024) return problem(413, "payload_too_large", "body over 64 KB");
        uploads.push({ auth: String(req.headers.authorization), encoding: String(req.headers["content-encoding"]), contentType: String(req.headers["content-type"]), gzBytes: raw.byteLength, env });
        return send(202, { id: `scn_up${uploads.length}`, status: "queued", source: "extension", trigger: "upload", position: 1, summary: null, report_url: null });
      }
      if (req.method === "POST" && url === "/api/v1/scans") {
        scans.push({ auth: String(req.headers.authorization), idem: String(req.headers["idempotency-key"] ?? ""), body: JSON.parse(raw.toString("utf8") || "{}") });
        return send(202, { id: "scn_bot", status: "queued", position: 3, source: "api", trigger: "manual" });
      }
      const m = /^\/api\/v1\/scans\/([\w-]+)$/.exec(url);
      if (req.method === "GET" && m) {
        const n = (polls.get(m[1]) ?? 0) + 1;
        polls.set(m[1], n);
        if (n < 2) return send(200, { id: m[1], status: "running" });
        const summary = m[1] === "scn_bot" ? { counts: {}, top: [], conversions: [], aborted: { reason: "bot_protection", detail: "HTTP 403" } } : { counts: { high: 1 }, top: [], conversions: [] };
        return send(200, { id: m[1], status: "done", summary, report_url: `${origin}/r/${m[1]}` });
      }
      if (url.startsWith("/r/")) return send(200, "<!doctype html><title>Report</title><h1>Report</h1>", "text/html");
      return send(404, { code: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, uploads, scans, problems, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/* --------------------------- shop fixture ---------------------------- */

async function startShop(): Promise<{ origin: string; hits: Array<{ method: string; path: string; body: string }>; close: () => Promise<void> }> {
  const hits: Array<{ method: string; path: string; body: string }> = [];
  const routes: Record<string, string> = { "/": "index.html", "/products/linen-shirt": "product.html", "/cart": "cart.html" };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const p = (req.url ?? "/").split("?")[0];
      hits.push({ method: req.method ?? "GET", path: p, body });
      if (req.method === "POST" && p === "/cart/add.js") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      // A first-party GA4 collect endpoint so the shop has tracking hits to record.
      if (p === "/g/collect") return void res.writeHead(204).end();
      const file = routes[p];
      if (req.method !== "GET" || !file) return void res.writeHead(404).end("not found");
      const port = req.socket.localPort;
      const html = (await readFile(SHOP + file, "utf8")).replace(
        "</body>",
        `<img alt="" src="http://localhost:${port}/pixel.gif?p=${encodeURIComponent(p)}"><script>window.dataLayer=window.dataLayer||[];dataLayer.push({event:"shop_view",email:"buyer@example.com"});navigator.sendBeacon("/g/collect?v=2&tid=G-SHOP&en=page_view","en=page_view");
document.getElementById("add")&&document.getElementById("add").addEventListener("click",function(){navigator.sendBeacon("/g/collect?v=2&tid=G-SHOP&en=add_to_cart","en=add_to_cart&ep.customer_email=buyer%40example.com")});</script></body>`,
      );
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/* ------------------------------ harness ------------------------------ */

let fx: FixtureServer;
let platform: Platform;
let ctx: BrowserContext;
let sw: Worker;
let extId = "";
let userDir = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tabIdOf(urlPrefix: string): Promise<number> {
  const id = await sw.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url ?? "").startsWith(prefix))?.id ?? -1;
  }, urlPrefix);
  assert.ok(id > 0, `tab for ${urlPrefix}`);
  return id;
}

async function openPanel(tabId: number): Promise<Page> {
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
  return panel;
}

async function view(panel: Page, name: string) {
  await panel.waitForFunction((v) => document.body.dataset.view === v, name, { timeout: 20_000 });
}

async function waitFor<T>(fn: () => T | undefined | null | false, what: string, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

before(async () => {
  if (skip) return;
  fx = await startFixtureServer();
  platform = await startPlatform();
  userDir = mkdtempSync(path.join(tmpdir(), "strv-ext-"));
  ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME,
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
  extId = new URL(sw.url()).host;
});

after(async () => {
  if (skip) return;
  await ctx?.close().catch(() => {});
  await fx?.close();
  await platform?.close();
  rmSync(userDir, { recursive: true, force: true });
});

/* ------------------------------- tests ------------------------------- */

test("Mode B: fresh visitor, consent marker, lead steps, review, gzip upload, report opens", { skip, timeout: 120_000 }, async () => {
  // A returning visitor's state first: consent cookie set. "Fresh visitor" must clear it.
  const site = await ctx.newPage();
  await site.goto(`${fx.origin}/`);
  await site.click("#acc");
  await waitFor(async () => (await ctx.cookies(fx.origin)).some((c) => c.name === "fx_consent"), "consent cookie");
  const tabId = await tabIdOf(fx.origin);

  const panel = await openPanel(tabId);
  await view(panel, "settings");
  await panel.fill("#key", KEY);
  await panel.fill("#base", platform.origin);
  await panel.click("#save");
  await view(panel, "home");
  assert.equal(await panel.inputValue("#url"), `${fx.origin}/`, "Mode A field prefilled from the tab");
  const stored = await sw.evaluate(() => chrome.storage.local.get("strv.settings"));
  assert.equal((stored["strv.settings"] as { key: string }).key, KEY);

  await panel.click("#record-b");
  await view(panel, "setup");
  await panel.check("#path-lead");
  const hitsBefore = fx.hits.length;
  await panel.click("#start");
  await view(panel, "confirm");
  assert.match(await panel.textContent("h1") ?? "", /Clear 127\.0\.0\.1\?/);
  await panel.click("#confirm-yes");
  await view(panel, "recording");

  // The tab reloads with the site's data cleared: no consent cookie, banner back.
  await waitFor(() => fx.hits.slice(hitsBefore).some((h) => h.method === "GET" && h.url === "/"), "reload");
  await site.bringToFront();
  await site.waitForSelector("#cookie-banner:not(.hidden)", { timeout: 10_000 });
  assert.ok(!(await ctx.cookies(fx.origin)).some((c) => c.name === "fx_consent"), "fresh visitor cleared the cookie");
  await sleep(1200);

  // Consent: click Accept in the page, then mark it in the panel a little later.
  await site.click("#acc");
  await sleep(1500);
  await panel.click("#mark-accept");
  await panel.waitForFunction(() => /Accept, marked by you/.test(document.querySelector("#consent-state")?.textContent ?? ""));

  // Lead steps: open the form page, click into the first field, stop before submit.
  await site.click('a[href="/contact.html"]');
  await site.waitForLoadState("load");
  await sleep(800);
  await panel.click("#step-done");
  await site.click('input[name="name"]');
  await sleep(300);
  await panel.click("#step-done");
  await panel.click("#step-done"); // "Stop before you submit or pay"
  await panel.waitForFunction(() => Number(document.querySelector("#count-tracking")?.textContent) >= 3, undefined, { timeout: 10_000 });

  await panel.click("#stop");
  await view(panel, "review");
  assert.ok(Number(await panel.textContent("#review-requests")) > 0);
  assert.ok(Number(await panel.textContent("#review-tracking")) >= 3);
  assert.match(await panel.textContent("#review-labels") ?? "", /Accepted\. Fresh visitor\./);
  assert.ok(await panel.$('[data-host="127.0.0.1"]'));

  const reportPage = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("/r/scn_up1"), timeout: 30_000 });
  await panel.click("#upload");
  await reportPage;
  await view(panel, "done");
  assert.ok(await panel.$("#open-report"));
  assert.equal(await panel.getAttribute("#audit", "href"), `${platform.origin}/audit`);

  /* ---- what reached the platform ---- */
  assert.deepEqual(platform.problems, []);
  assert.equal(platform.uploads.length, 1);
  const up = platform.uploads[0];
  assert.equal(up.auth, `Bearer ${KEY}`);
  assert.equal(up.encoding, "gzip");
  assert.ok(up.gzBytes < 2 * 1024 * 1024);
  const env = up.env;
  assert.deepEqual(Object.keys(env).sort(), ["capture", "clientVersion", "consentMarkerTs", "guidedSteps", "visitor"]);
  assert.equal(env.visitor, "fresh");
  assert.equal(env.clientVersion, "0.1.0");
  assert.equal(env.capture.region, "Recorded in your browser");
  assert.equal(env.capture.scenarios.length, 1);
  const run = env.capture.scenarios[0];
  assert.equal(run.scenario, "accept");
  assert.equal(run.banner, "clicked");
  assert.equal(typeof env.consentMarkerTs, "number");

  // GA4 hits from the fixture, with the right phases.
  const ga = run.requests.filter((r: CapturedRequest) => r.url.includes("/g/collect"));
  const find = (en: string, page: string) => ga.find((r) => r.url.includes(`en=${en}`) && r.pageUrl.endsWith(page));
  const pv = find("page_view", "/");
  const granted = find("consent_granted", "/");
  const pvContact = find("page_view", "/contact.html");
  assert.ok(pv && granted && pvContact, JSON.stringify(ga.map((r) => [r.url, r.pageUrl, r.phase])));
  assert.equal(pv.phase, "pre");
  assert.match(pv.url, /gcs=G100/, "the reload ran without the old consent cookie");
  assert.equal(pv.postData, "en=page_view", "tracking body kept");
  assert.equal(granted.phase, "post");
  assert.ok(granted.ts >= env.consentMarkerTs!, "the marker moved back to the page click");
  assert.ok(pv.ts < env.consentMarkerTs!);
  assert.equal(pvContact.phase, "post");
  assert.match(pvContact.url, /gcs=G111/);
  assert.ok(!ga.some((r) => r.ts < 0));

  // Each fixture hit is one request (no duplicates from the recorder).
  assert.equal(ga.filter((r) => r === pv || (r.url.includes("en=page_view") && r.pageUrl.endsWith("/") && r.phase === "pre")).length, 1);
  assert.equal(new Set(ga.map((r) => r.id)).size, ga.length);
  // The engine decoder reads them as GA4 hits with the right phases. The fixture puts `en` in both the
  // query and the body, which the decoder reads as two events of one request: compare per request.
  const hits = decodeAll(run.requests, "127.0.0.1").filter((h) => h.vendor === "ga4");
  const perRequest = [...new Map(hits.map((h) => [h.requestId, `${h.eventName}:${h.phase}:${h.accountId}`])).values()];
  assert.deepEqual(perRequest, ["page_view:pre:G-TEST", "consent_granted:post:G-TEST", "page_view:post:G-TEST"]);

  // Non-tracking POSTs are recorded without their bodies; nothing was submitted.
  const lead = run.requests.find((r) => r.url.endsWith("/api/lead"));
  assert.ok(lead && lead.method === "POST" && lead.postData === undefined);
  assert.ok(!fx.hits.some((h) => h.url.startsWith("/submit")));

  // dataLayer: INIT_SCRIPT copies, split by the marker.
  const dl = run.dataLayer.map((d) => ({ ev: (d.payload as { event?: string })?.event, phase: d.phase }));
  assert.ok(dl.some((d) => d.ev === "page_meta" && d.phase === "pre"), JSON.stringify(dl));
  assert.ok(dl.some((d) => d.ev === "consent_update" && d.phase === "post"));
  assert.ok(dl.some((d) => d.ev === "contact_view" && d.phase === "post"));
  assert.equal(run.gtagConsent?.pre?.analytics_storage, "denied");
  assert.equal(run.gtagConsent?.post?.analytics_storage, "granted");

  // Cookies: names only, the consent cookie only after the choice.
  assert.ok(run.cookies.some((c) => c.name === "fx_consent" && c.phase === "post"));
  assert.ok(!run.cookies.some((c) => c.name === "fx_consent" && c.phase === "pre"));
  assert.ok(run.cookies.every((c) => Object.keys(c).sort().join() === "domain,firstParty,name,phase,scenario"));

  // Guided steps.
  assert.deepEqual(env.guidedSteps.map((s) => [s.name, s.ok]), [["fresh_visitor", true], ["open_form_page", true], ["form_start", true], ["stopped", true]]);
  const fs = env.guidedSteps.find((s) => s.name === "form_start")!;
  assert.equal(fs.conversionType, "lead");
  assert.ok(fs.pageUrl?.endsWith("/contact.html"));

  // No PII anywhere in the upload.
  const all = JSON.stringify(env);
  for (const pii of ["jane.doe", "example.com", "+33 6 12 34 56 78", "612345678", "fx_consent=granted"]) assert.ok(!all.includes(pii), `upload contains ${pii}`);
  assert.ok(!/"value":\s*"granted"/.test(JSON.stringify(run.cookies)));

  // After the upload: nothing left in IndexedDB, session done, scripts unregistered.
  const left = await sw.evaluate(async () => ({
    scripts: (await chrome.scripting.getRegisteredContentScripts()).length,
    session: ((await chrome.storage.local.get("strv.session"))["strv.session"] as { state: string }).state,
  }));
  assert.deepEqual(left, { scripts: 0, session: "done" });
  await panel.close();
});

test("Mode A: scan on Strativra, bot protection offers Mode B", { skip, timeout: 60_000 }, async () => {
  const tabId = await tabIdOf(fx.origin);
  const panel = await openPanel(tabId);
  await view(panel, "done");
  await panel.click("#new-check");
  await view(panel, "home");
  await panel.fill("#url", "bot-wall.example");
  const report = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("/r/scn_bot"), timeout: 30_000 });
  await panel.click("#scan-a");
  await view(panel, "scan");
  await report;
  await panel.waitForSelector("#bot-wall");
  assert.equal(platform.scans.length, 1);
  assert.deepEqual(platform.scans[0].body, { url: "https://bot-wall.example" });
  assert.equal(platform.scans[0].auth, `Bearer ${KEY}`);
  assert.match(platform.scans[0].idem, /^[0-9a-f-]{36}$/);
  await panel.click("#record-b");
  await view(panel, "setup");
  await panel.close();
});

test("Mode B as is: shop path, add-to-cart POST body never kept, host removed on review", { skip, timeout: 120_000 }, async () => {
  const shop = await startShop();
  try {
    const site = await ctx.newPage();
    await site.goto(`${shop.origin}/`);
    const tabId = await tabIdOf(shop.origin);
    const panel = await openPanel(tabId);
    await view(panel, "home");
    await panel.click("#record-b");
    await view(panel, "setup");
    await panel.check("#visitor-returning");
    await panel.check("#path-ecommerce");
    await panel.click("#start");
    await view(panel, "recording");
    await sleep(1000);

    await site.bringToFront();
    await site.click('a[href="/products/linen-shirt"]');
    await site.waitForLoadState("load");
    await sleep(800);
    await panel.click("#step-done"); // view_item
    await site.click("#add");
    await waitFor(() => shop.hits.some((h) => h.path === "/cart/add.js"), "add to cart POST");
    await sleep(800);
    await panel.click("#step-done"); // add_to_cart
    await panel.click("#step-skip"); // begin_checkout
    await panel.click("#step-done"); // stop before you pay
    await panel.click("#stop");
    await view(panel, "review");
    assert.match(await panel.textContent("#review-labels") ?? "", /No consent choice\. Returning visitor\./);
    // A second host (the pixel on localhost) is listed and can be removed before anything is sent.
    await panel.waitForSelector('[data-host="localhost"]');
    const before = Number(await panel.textContent("#review-requests"));
    await panel.click('[data-remove="localhost"]');
    await panel.waitForSelector('[data-host="localhost"]', { state: "detached" });
    assert.ok(Number(await panel.textContent("#review-requests")) < before);

    const reportPage = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("/r/scn_up2"), timeout: 30_000 });
    await panel.click("#upload");
    await reportPage;
    const env = platform.uploads[1].env;
    const run = env.capture.scenarios[0];
    assert.equal(run.scenario, "none");
    assert.ok(run.requests.every((r) => r.phase === "pre"));
    assert.equal(env.consentMarkerTs, undefined);
    const add = run.requests.find((r) => r.url.endsWith("/cart/add.js"));
    assert.ok(add && add.method === "POST" && add.postData === undefined, "non-tracking body never kept");
    const atc = run.requests.find((r) => r.url.includes("en=add_to_cart"));
    assert.ok(atc?.postData?.includes("en=add_to_cart"));
    assert.ok(!JSON.stringify(env).includes("buyer"), "emails redacted");
    assert.ok(!run.requests.some((r) => new URL(r.url).hostname === "localhost"), "removed host not uploaded");
    assert.ok(shop.hits.some((h) => h.path === "/pixel.gif"), "the pixel did load");
    assert.deepEqual(env.guidedSteps.map((s) => [s.name, s.ok]), [["returning_visitor", true], ["view_item", true], ["add_to_cart", true], ["begin_checkout", false], ["stopped", true]]);
    const atcStep = env.guidedSteps.find((s) => s.name === "add_to_cart")!;
    assert.ok(Math.abs(atcStep.ts - atc!.ts) < 1000, "step time is the page click, not the button press");
    await panel.close();
    await site.close();
  } finally {
    await shop.close();
  }
});
