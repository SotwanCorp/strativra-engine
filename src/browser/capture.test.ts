import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrackingUrl, registrableDomain, safetyVerdict } from "./capture.ts";

test("isTrackingUrl: known hosts and first-party collect paths", () => {
  for (const u of [
    "https://region1.google-analytics.com/g/collect?v=2&tid=G-1",
    "https://analytics.google.com/g/collect?v=2",
    "https://www.googletagmanager.com/gtag/js?id=G-1",
    "https://www.googleadservices.com/pagead/conversion/123/",
    "https://ad.doubleclick.net/activity;src=1",
    "https://www.google.com/pagead/1p-conversion/123/",
    "https://www.google.de/ccm/collect?en=page_view",
    "https://www.facebook.com/tr/?id=1&ev=PageView",
    "https://px.ads.linkedin.com/collect?pid=1",
    "https://analytics.tiktok.com/api/v2/pixel",
    "https://bat.bing.com/action/0?ti=1",
    "https://y.clarity.ms/collect",
    "https://script.hotjar.com/modules.js",
    "https://sgtm.shop.com/g/collect?v=2&tid=G-1&en=page_view",
    "https://shop.com/metrics/collect?v=2&tid=G-1",
  ]) assert.equal(isTrackingUrl(u), true, u);
  for (const u of [
    "https://shop.com/collect",
    "https://shop.com/api/lead",
    "https://www.google.com/search?q=x",
    "https://www.facebook.com/login",
    "https://evil-google-analytics.com.attacker.net/g/collect",
    "not a url",
  ]) assert.equal(isTrackingUrl(u), false, u);
});

test("safetyVerdict: form posts, unsafe methods, payments", () => {
  assert.equal(safetyVerdict("https://shop.com/contact", "GET", true), null);
  assert.equal(safetyVerdict("https://shop.com/submit", "POST", true), "form_submit");
  assert.equal(safetyVerdict("https://shop.com/wp-json/contact-form-7/v1/feedback", "POST", false), "form_submit");
  assert.equal(safetyVerdict("https://shop.com/api/x", "PUT", false), "unsafe_method");
  assert.equal(safetyVerdict("https://shop.com/api/x", "DELETE", false), "unsafe_method");
  assert.equal(safetyVerdict("https://region1.google-analytics.com/g/collect?v=2&tid=G-1", "POST", false), null);
  assert.equal(safetyVerdict("https://www.facebook.com/tr/", "POST", false), null);
  assert.equal(safetyVerdict("https://checkout.stripe.com/c/pay/cs_test", "GET", true), "payment");
  assert.equal(safetyVerdict("https://js.stripe.com/v3/", "GET", false), null);
  assert.equal(safetyVerdict("https://api.stripe.com/v1/payment_intents", "POST", false), "payment");
  assert.equal(safetyVerdict("https://www.paypal.com/checkoutnow", "GET", true), "payment");
  assert.equal(safetyVerdict("https://shop.com/cart/checkout", "POST", false), "payment");
  assert.equal(safetyVerdict("https://shop.com/checkout", "GET", true), null, "viewing a checkout page is allowed");
});

test("same-site add-to-cart POST passes; checkout/order and cross-site stay blocked", () => {
  const site = { siteHost: "www.shop.com" };
  assert.equal(safetyVerdict("https://www.shop.com/cart/add.js", "POST", false, site), null);
  assert.equal(safetyVerdict("https://shop.com/en/cart/add", "POST", true, site), null);
  assert.equal(safetyVerdict("https://www.shop.com/?wc-ajax=add_to_cart", "POST", false, site), null);
  assert.equal(safetyVerdict("https://www.shop.com/product/x/?add-to-cart=123", "POST", true, site), null);
  assert.equal(
    safetyVerdict("https://www.shop.com/wp-admin/admin-ajax.php", "POST", false, { ...site, postData: "action=woocommerce_add_to_cart&product_id=1" }),
    null,
  );
  assert.equal(safetyVerdict("https://www.shop.com/wp-admin/admin-ajax.php", "POST", false, { ...site, postData: "action=send_contact" }), "form_submit");
  assert.equal(safetyVerdict("https://www.shop.com/checkout", "POST", true, site), "payment");
  assert.equal(safetyVerdict("https://www.shop.com/order", "POST", false, site), "form_submit");
  assert.equal(safetyVerdict("https://www.shop.com/api/orders", "POST", false, site), "form_submit");
  assert.equal(safetyVerdict("https://evil.com/cart/add.js", "POST", false, site), "form_submit");
  assert.equal(safetyVerdict("https://www.shop.com/cart/add.js", "POST", false), "form_submit", "no site host, no allow");
  assert.equal(safetyVerdict("https://www.shop.com/cart/add.js", "PUT", false, site), "unsafe_method");
  assert.equal(registrableDomain("a.b.shop.co.uk"), "shop.co.uk");
});
