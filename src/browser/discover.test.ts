/**
 * Browser tests on local fixtures (no live sites). The fixture servers log every request so we can
 * assert the safety guarantees: no form submission, no checkout/order POST, no tel navigation.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import type { AddressInfo } from "node:net";
import { discoverPage, collectLinks } from "./discover.ts";
import { walkFunnels } from "./walk.ts";

const FIX = fileURLToPath(new URL("./discover-fixtures/", import.meta.url));
const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";

interface Hit { method: string; path: string; body: string }

async function serve(dir: string, routes: Record<string, string>): Promise<{ origin: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const path = (req.url || "/").split("?")[0]!;
      hits.push({ method: req.method || "GET", path, body });
      if (req.method === "POST" && path === "/cart/add.js") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        return;
      }
      const file = routes[path] ?? (path.endsWith(".html") ? path.slice(1) : null);
      if (req.method !== "GET" || !file) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      try {
        const html = await readFile(dir + file, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      } catch {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) };
}

let browser: Browser;
async function newContext(): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  // Offline: only the local fixture servers are reachable.
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "127.0.0.1") return route.continue();
    return route.abort();
  });
  return ctx;
}

before(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => {
  await browser?.close();
});

test("services site: discovery, classification, safe walks", async () => {
  const srv = await serve(FIX + "services/", { "/": "index.html", "/contact": "contact.html" });
  const ctx = await newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(srv.origin + "/", { waitUntil: "load" });
    await page.waitForTimeout(200); // let the same-origin iframes load
    const d = await discoverPage(page, { siteHost: "127.0.0.1" });

    const kinds = Object.fromEntries(d.forms.map((f) => [f.selector + (f.frameUrl ? "@frame" : ""), f.kind]));
    assert.equal(kinds["#contact-form"], "contact");
    assert.equal(kinds["#login-form"], "login");
    assert.equal(kinds["#site-search"], "search");
    assert.equal(kinds["#newsletter"], "newsletter");
    assert.equal(kinds["#quote-form@frame"], "contact");
    assert.ok(d.forms.some((f) => !f.isFormElement && f.kind === "signup"), "form-like div classified as signup");
    assert.ok(d.platformHints.includes("WordPress"));

    const by = (t: string) => d.points.filter((p) => p.type === t);
    const contact = d.points.find((p) => p.selector === "#contact-form")!;
    assert.equal(contact.type, "lead");
    assert.equal(contact.detectedBy, "cf7");
    assert.ok(by("lead").some((p) => /iframe/.test(p.label)), "quote form in same-origin iframe");
    const nl = by("lead").find((p) => p.selector === "#newsletter")!;
    assert.ok(nl.confidence < 0.4);
    assert.equal(by("signup").length, 1);
    assert.ok(!d.points.some((p) => p.selector === "#login-form" || p.selector === "#site-search"));
    const booking = by("booking");
    assert.equal(booking.length, 1);
    assert.equal(booking[0]!.detectedBy, "calendly");
    assert.deepEqual(by("contact_click").map((p) => p.label).sort(), ["Email link", "Phone link", "WhatsApp link"]);
    assert.equal(by("download").length, 1);
    for (const p of d.points) assert.ok(p.id && p.label && p.confidence > 0 && p.confidence <= 1);

    const links = await collectLinks(page, "127.0.0.1", 5);
    assert.equal(links[0], srv.origin + "/contact");
    assert.ok(links.includes(srv.origin + "/book"));
    assert.ok(!links.some((u) => /login|logout|wp-admin|mailto/.test(u)));

    const startedAt = Date.now();
    const r = await walkFunnels(page, d.points, { scenario: "accept", startedAt, siteHost: "127.0.0.1" });
    const names = (p: { walk: { name: string; ok: boolean }[] }) => p.walk.map((s) => `${s.name}:${s.ok}`);

    assert.deepEqual(names(contact), ["form_view:true", "form_start:true"]);
    assert.match(contact.walk[1]!.action, /your-name/);
    // Only the safe text field got typed into; email/phone/message untouched.
    assert.equal(await page.inputValue("#contact-form [name=your-name]"), "test");
    assert.equal(await page.inputValue("#contact-form [name=your-email]"), "");
    assert.equal(await page.inputValue("#contact-form [name=your-phone]"), "");

    const signup = by("signup")[0]!;
    assert.deepEqual(names(signup), ["form_view:true", "form_start:false"], "no safe field in a signup with only email+password");
    assert.equal(await page.inputValue("[name=signup-email]"), "");

    for (const p of by("contact_click")) assert.deepEqual(names(p), ["click:true"], p.label);
    assert.equal(page.url(), srv.origin + "/", "tel/mailto/whatsapp clicks did not navigate");
    assert.deepEqual(names(booking[0]!), ["booking_view:true"]);
    assert.deepEqual(names(by("download")[0]!), ["download_view:true"]);
    assert.ok(r.steps.every((s) => s.scenario === "accept" && s.ts >= 0));
    // GTM-like listeners still saw the clicks.
    const dl = await page.evaluate(() => (window as unknown as { dataLayer: Array<{ event: string; href?: string }> }).dataLayer);
    assert.ok(dl.some((e) => e.event === "link_click" && e.href?.startsWith("tel:")));
    assert.ok(dl.some((e) => e.event === "form_start_fixture"));

    // Safety: the server never received a POST or a form submission.
    assert.deepEqual(srv.hits.filter((h) => h.method !== "GET"), []);
    assert.ok(!srv.hits.some((h) => /submit|subscribe|login/.test(h.path)), JSON.stringify(srv.hits));
  } finally {
    await ctx.close();
    await srv.close();
  }
});

test("shop: add to cart once, cart, checkout page, stop", async () => {
  const srv = await serve(FIX + "shop/", {
    "/": "index.html",
    "/products/linen-shirt": "product.html",
    "/cart": "cart.html",
    "/checkout": "checkout.html",
  });
  const ctx = await newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(srv.origin + "/", { waitUntil: "load" });
    const links = await collectLinks(page, "127.0.0.1", 4);
    assert.deepEqual(links, [srv.origin + "/products/linen-shirt", srv.origin + "/collections/all", srv.origin + "/cart", srv.origin + "/about"]);

    await page.goto(srv.origin + "/products/linen-shirt", { waitUntil: "load" });
    const d = await discoverPage(page, { siteHost: "127.0.0.1" });
    const purchase = d.points.filter((p) => p.type === "purchase");
    const atc = purchase.find((p) => p.detectedBy === "generic")!;
    assert.equal(atc.selector, "#add", "add to cart, not buy now");
    assert.ok(atc.confidence >= 0.9);
    const stripe = purchase.find((p) => p.detectedBy === "stripe")!;
    assert.ok(stripe);
    assert.ok(!d.points.some((p) => p.type === "lead"), "search form is not a lead");

    const r = await walkFunnels(page, d.points, { scenario: "none", startedAt: Date.now(), siteHost: "127.0.0.1" });
    assert.deepEqual(atc.walk.map((s) => `${s.name}:${s.ok}`), ["view_item:true", "add_to_cart:true", "view_cart:true", "begin_checkout:true"]);
    assert.deepEqual(stripe.walk.map((s) => `${s.name}:${s.ok}`), ["checkout_link:true"]);
    assert.equal(new URL(page.url()).pathname, "/checkout");
    assert.ok(r.visits.some((v) => v.via === "funnel" && v.url.endsWith("/cart") && v.status === 200));

    // Checkout page: classified as checkout, never a point, nothing typed.
    const onCheckout = await discoverPage(page, { siteHost: "127.0.0.1" });
    assert.equal(onCheckout.forms[0]!.kind, "checkout");
    assert.equal(onCheckout.points.filter((p) => p.type === "lead" || p.type === "signup").length, 0);
    assert.equal(await page.inputValue("[name=cardnumber]"), "");

    const posts = srv.hits.filter((h) => h.method !== "GET");
    assert.deepEqual(posts.map((h) => h.path), ["/cart/add.js"], "only one add to cart call");
    assert.equal(JSON.parse(posts[0]!.body).quantity, 1);
    assert.ok(!srv.hits.some((h) => h.path === "/order"));
    assert.ok(!srv.hits.some((h) => h.path === "/checkout" && h.method !== "GET"));
    assert.equal(srv.hits.filter((h) => h.path === "/checkout").length, 1, "buy now never clicked");
  } finally {
    await ctx.close();
    await srv.close();
  }
});
