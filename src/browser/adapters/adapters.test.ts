import { test } from "node:test";
import assert from "node:assert/strict";
import type { PageSnapshot } from "./types.ts";
import { ADAPTERS, detectPlatformHints, snapshotRequest } from "./index.ts";
import { isSameSite, isPaymentHost } from "./hosts.ts";
import { genericHits, buildPoints, pickLinks } from "../discover.ts";

function snap(over: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: "https://shop.example.com/p/1", title: "", bodyClass: "", generator: "", ogType: "", jsonLdTypes: [],
    scripts: [], iframes: [], links: [], buttons: [], forms: [], markers: {}, globals: [], keywords: [],
    ...over,
  };
}
const hitsOf = (s: PageSnapshot) => ADAPTERS.flatMap((a) => a.detect(s).map((h) => ({ ...h, adapterId: a.id })));
const link = (href: string, text = "x") => ({ href, text, selector: `a[href="${href}"]`, inNav: false, download: false });

test("hosts: same-site and payment hosts", () => {
  assert.ok(isSameSite("www.example.com", "example.com"));
  assert.ok(isSameSite("shop.example.com", "example.com:443"));
  assert.ok(!isSameSite("example.com.evil.net", "example.com"));
  assert.ok(isPaymentHost("checkout.stripe.com"));
  assert.ok(!isPaymentHost("example.com"));
});

test("snapshotRequest merges adapter markers, globals, keywords", () => {
  const r = snapshotRequest();
  assert.ok(r.markers.includes(".calendly-inline-widget"));
  assert.ok(r.globals.includes("Shopify"));
  assert.ok(r.keywords.includes("wc-ajax"));
});

test("schedulers: one booking point per tool, type booking", () => {
  const s = snap({
    iframes: [{ src: "https://calendly.com/acme/30min?embed=true", selector: "iframe", title: "" }],
    links: [link("https://calendly.com/acme"), link("https://cal.com/acme/intro"), link("https://meetings-eu1.hubspot.com/acme")],
  });
  const h = hitsOf(s).filter((x) => x.type === "booking");
  assert.deepEqual(h.map((x) => x.adapterId).sort(), ["cal_com", "calendly", "hubspot_meetings"]);
  assert.equal(h.find((x) => x.adapterId === "calendly")!.meta.embed, "iframe");
  assert.match(h.find((x) => x.adapterId === "calendly")!.label, /Calendly/);
});

test("embedded forms and chat", () => {
  const s = snap({
    iframes: [{ src: "https://form.typeform.com/to/abc", selector: "#tf", title: "" }],
    links: [link("https://forms.gle/xyz"), link("https://docs.google.com/document/d/1")],
    scripts: ["https://widget.intercom.io/widget/abc"],
    globals: ["$crisp"],
  });
  const h = hitsOf(s);
  assert.ok(h.some((x) => x.adapterId === "typeform" && x.type === "lead"));
  assert.ok(h.some((x) => x.adapterId === "google_forms" && x.type === "lead"));
  assert.ok(h.some((x) => x.adapterId === "intercom" && x.type === "contact_click" && x.meta.channel === "chat"));
  assert.ok(h.some((x) => x.adapterId === "crisp"));
});

test("shopify / woocommerce / stripe", () => {
  const shop = snap({ globals: ["Shopify"], markers: { "form[action*='/cart/add'] button[name='add']": { count: 1, selector: "#atc", formSelector: "#f" } } });
  const sh = hitsOf(shop).find((x) => x.adapterId === "shopify");
  assert.equal(sh?.selector, "#atc");
  assert.ok(detectPlatformHints(shop).includes("Shopify"));

  const woo = snap({ bodyClass: "single-product woocommerce", markers: { "button.single_add_to_cart_button": { count: 1, selector: "#w", formSelector: "#wf" } } });
  assert.equal(hitsOf(woo).find((x) => x.adapterId === "woocommerce")?.key, "purchase:add_to_cart");
  assert.ok(detectPlatformHints(woo).includes("WooCommerce"));

  const st = snap({ links: [link("https://buy.stripe.com/abc")] });
  const sp = hitsOf(st).find((x) => x.adapterId === "stripe");
  assert.equal(sp?.meta.walkable, false);
});

test("generic: add to cart, contact channels, downloads", () => {
  const s = snap({
    jsonLdTypes: ["Product"],
    buttons: [
      { tag: "button", text: "Buy now", selector: "#buy", name: "", type: "button", classes: "", productId: false, formAction: "", href: "" },
      { tag: "button", text: "Ajouter au panier", selector: "#atc", name: "", type: "button", classes: "", productId: false, formAction: "", href: "" },
    ],
    links: [link("https://shop.example.com/cart"), link("tel:+1"), link("mailto:a@b.c"), link("https://wa.me/1"), link("https://cdn.example.net/x/Guide.pdf"), link("https://cdn.example.net/x/Guide.pdf")],
  });
  const h = genericHits(s, "example.com");
  const atc = h.find((x) => x.key === "purchase:add_to_cart");
  assert.equal(atc?.selector, "#atc");
  assert.equal(atc?.meta.cartUrl, "https://shop.example.com/cart");
  assert.deepEqual(h.filter((x) => x.type === "contact_click").map((x) => x.meta.channel), ["phone", "email", "whatsapp"]);
  assert.equal(h.filter((x) => x.type === "download").length, 1);
});

test("buildPoints: DOM form adapter relabels the classified form; login/search never become points", () => {
  const s = snap({ url: "https://example.com/", markers: { "form.wpcf7-form": { count: 1, selector: "#c", formSelector: "#c" } } });
  const base = { isFormElement: true, action: "", method: "post", textInputs: 0, nameInputs: 0, emailInputs: 0, telInputs: 0, passwordInputs: 0, searchInputs: 0, textareas: 0, selects: 0, checkboxes: 0, fileInputs: 0, autocomplete: [], names: [], descriptors: [], roleSearch: false, inFooter: false, text: "", classes: "", buttons: [] };
  const forms = [
    { ...base, selector: "#c", fields: 4, kind: "contact" as const, confidence: 0.8, scores: { login: 0, signup: 0, search: 0, newsletter: 0, contact: 9, checkout: 0 } },
    { ...base, selector: "#l", fields: 2, kind: "login" as const, confidence: 0.8, scores: { login: 9, signup: 0, search: 0, newsletter: 0, contact: 0, checkout: 0 } },
  ];
  const pts = buildPoints(s, forms, hitsOf(s), "example.com").map((b) => b.point);
  assert.equal(pts.length, 1);
  assert.equal(pts[0]!.type, "lead");
  assert.equal(pts[0]!.detectedBy, "cf7");
  assert.match(pts[0]!.label, /Contact Form 7/);
  // stable ids
  const again = buildPoints(s, forms, hitsOf(s), "example.com").map((b) => b.point.id);
  assert.deepEqual(again, pts.map((p) => p.id));
});

test("pickLinks: key pages first, same-site only, exclusions, dedupe, max", () => {
  const links = [
    { href: "https://example.com/", text: "Home", inNav: true },
    { href: "https://example.com/blog", text: "Blog", inNav: true },
    { href: "https://example.com/about-us/", text: "About", inNav: true },
    { href: "https://example.com/contact#form", text: "Contact", inNav: true },
    { href: "https://example.com/contact", text: "Contact", inNav: false },
    { href: "https://example.com/wp-admin/", text: "Admin", inNav: true },
    { href: "https://example.com/my-account/", text: "Account", inNav: true },
    { href: "https://example.com/logout", text: "Log out", inNav: true },
    { href: "https://other.com/contact", text: "Contact", inNav: true },
    { href: "mailto:a@example.com", text: "Mail", inNav: true },
    { href: "https://www.example.com/book-a-call", text: "Book", inNav: false },
    { href: "https://example.com/products/shirt", text: "Shirt", inNav: false },
    { href: "https://example.com/cart", text: "Cart", inNav: true },
    { href: "https://example.com/files/a.pdf", text: "PDF", inNav: true },
  ];
  const out = pickLinks(links, "https://example.com/", "example.com", 10);
  assert.deepEqual(out.slice(0, 5), [
    "https://example.com/contact",
    "https://www.example.com/book-a-call",
    "https://example.com/products/shirt",
    "https://example.com/cart",
    "https://example.com/about-us",
  ]);
  assert.ok(out.includes("https://example.com/blog"));
  assert.ok(!out.some((u) => /admin|account|logout|other\.com|mailto|\.pdf/.test(u)));
  assert.equal(pickLinks(links, "https://example.com/", "example.com", 2).length, 2);
});
