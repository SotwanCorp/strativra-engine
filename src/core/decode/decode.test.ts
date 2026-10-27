import { test } from "node:test";
import assert from "node:assert/strict";
import type { CapturedRequest } from "../../types.ts";
import { decodeAll, decodeRequest, isFirstParty, registrableDomain } from "./index.ts";

const SITE = "www.example-shop.co.uk";

function req(url: string, extra: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: "r1", scenario: "accept", phase: "post", ts: 1234,
    pageUrl: "https://www.example-shop.co.uk/checkout/thank-you",
    url, method: extra.postData ? "POST" : "GET", resourceType: "fetch", ...extra,
  };
}

const GA4_BASE =
  "https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123XYZ&gtm=45je4a&_p=1729680000123" +
  "&gcs=G111&gcd=13r3r3r3r5&npa=0&dma=1&cid=1234567890.1729680000&uid=user-42" +
  "&ul=en-gb&sr=1440x900&dl=https%3A%2F%2Fwww.example-shop.co.uk%2Fcheckout%2Fthank-you%3Fe%3Djane%2540mail.com" +
  "&dt=Thank%20you&sid=1729680000&sct=3&seg=1";

test("GA4 purchase with items, value, currency, transaction id", () => {
  const url = GA4_BASE +
    "&en=purchase&_et=15&cu=EUR&ep.transaction_id=T-1001&epn.value=59.98&epn.tax=4.5&ep.coupon=SUMMER" +
    "&pr1=idSKU-1~nmBlue%20Shirt~pr19.99~qt2~caApparel~brAcme~k0color~v0blue" +
    "&pr2=idSKU-2~nmCap~pr20~qt1";
  const hits = decodeRequest(req(url), SITE);
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.vendor, "ga4");
  assert.equal(h.accountId, "G-ABC123XYZ");
  assert.equal(h.eventName, "purchase");
  assert.equal(h.firstParty, false);
  assert.equal(h.params.transaction_id, "T-1001");
  assert.equal(h.params.value, 59.98);
  assert.equal(h.params.tax, 4.5);
  assert.equal(h.params.currency, "EUR");
  assert.equal(h.params.engagement_time_msec, 15);
  assert.equal(h.params.page_title, "Thank you");
  assert.deepEqual(h.params.items, [
    { item_id: "SKU-1", item_name: "Blue Shirt", price: 19.99, quantity: 2, item_category: "Apparel", item_brand: "Acme", color: "blue" },
    { item_id: "SKU-2", item_name: "Cap", price: 20, quantity: 1 },
  ]);
  // cid / uid presence only, never the value.
  assert.equal(h.params.client_id, "present");
  assert.equal(h.params.user_id, "present");
  assert.ok(!JSON.stringify(h).includes("1234567890"));
  assert.ok(!JSON.stringify(h).includes("user-42"));
  // e-mail leaking through dl is redacted.
  assert.ok(!JSON.stringify(h).includes("jane"));
  assert.equal(h.consent?.raw.gcs, "G111");
  assert.equal(h.consent?.keys.ad_user_data?.current, "granted");
});

test("GA4 currency falls back to ep.currency", () => {
  const hits = decodeRequest(req(GA4_BASE.replace("&cid=1234567890.1729680000", "") + "&en=add_to_cart&ep.currency=USD&epn.value=10"), SITE);
  assert.equal(hits[0].params.currency, "USD");
  assert.equal(hits[0].params.value, 10);
});

test("GA4 batched POST: 3 events in body, merged over shared query", () => {
  const body = [
    "en=page_view&_et=0&_ss=1",
    "en=view_item&_et=1200&ep.item_list_name=Shirts&pr1=idSKU-1~nmBlue%20Shirt~pr19.99",
    "en=scroll&_et=3400&epn.percent_scrolled=90&dt=Overridden",
    "",
  ].join("\n");
  const hits = decodeRequest(req(GA4_BASE, { postData: body }), SITE);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.eventName), ["page_view", "view_item", "scroll"]);
  for (const h of hits) {
    assert.equal(h.accountId, "G-ABC123XYZ");
    assert.equal(h.requestId, "r1");
    assert.equal(h.consent?.raw.gcd, "13r3r3r3r5");
  }
  assert.equal(hits[0].params.session_start, 1);
  assert.deepEqual(hits[1].params.items, [{ item_id: "SKU-1", item_name: "Blue Shirt", price: 19.99 }]);
  assert.equal(hits[2].params.percent_scrolled, 90);
  assert.equal(hits[2].params.page_title, "Overridden");
  assert.equal(hits[0].params.page_title, "Thank you");
});

test("GA4 first event in query string plus 2 in body = 3 events", () => {
  const body = "en=user_engagement&_et=5000\nen=form_start&ep.form_id=contact";
  const hits = decodeRequest(req(GA4_BASE + "&en=page_view", { postData: body }), SITE);
  assert.deepEqual(hits.map((h) => h.eventName), ["page_view", "user_engagement", "form_start"]);
  assert.equal(hits[2].params.form_id, "contact");
});

test("sGTM: first-party /g/collect is GA4 with firstParty=true", () => {
  const url = GA4_BASE.replace("https://region1.google-analytics.com", "https://metrics.example-shop.co.uk") + "&en=page_view";
  const hits = decodeRequest(req(url), SITE);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].vendor, "ga4");
  assert.equal(hits[0].firstParty, true);
});

test("sGTM: first-party custom path only with GA4 shape", () => {
  const ok = decodeRequest(req("https://sst.example-shop.co.uk/x7/data?v=2&tid=G-ABC123XYZ&en=page_view"), SITE);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].firstParty, true);
  const no = decodeRequest(req("https://www.example-shop.co.uk/api/cart?v=2&tid=foo"), SITE);
  assert.equal(no.length, 0);
});

test("Google Ads conversion with enhanced conversions signal", () => {
  const url = "https://www.googleadservices.com/pagead/conversion/987654321/?random=1&cv=11&fst=1&label=AbC-dEfGhIjK&value=59.98" +
    "&currency_code=EUR&oid=T-1001&gcs=G111&gcd=13r3r3r3r5&em=tv.1~em.abcdef0123456789&url=https%3A%2F%2Fwww.example-shop.co.uk%2Fthanks";
  const [h] = decodeRequest(req(url), SITE);
  assert.equal(h.vendor, "google_ads");
  assert.equal(h.accountId, "AW-987654321");
  assert.equal(h.eventName, "conversion");
  assert.equal(h.conversionLabel, "AbC-dEfGhIjK");
  assert.equal(h.params.value, 59.98);
  assert.equal(h.params.currency, "EUR");
  assert.equal(h.params.transaction_id, "T-1001");
  assert.equal(h.params.ec, "present");
  assert.ok(!JSON.stringify(h).includes("abcdef0123456789"));
});

test("Google Ads remarketing (no label) and 1p-conversion on google.com", () => {
  const [r] = decodeRequest(req("https://googleads.g.doubleclick.net/pagead/viewthroughconversion/987654321/?random=2&cv=11"), SITE);
  assert.equal(r.eventName, "remarketing");
  assert.equal(r.accountId, "AW-987654321");
  const [p] = decodeRequest(req("https://www.google.com/pagead/1p-conversion/987654321/?label=XyZ&value=1&currency_code=GBP"), SITE);
  assert.equal(p.eventName, "conversion");
  assert.equal(p.params.hit_type, "1p");
  const [c] = decodeRequest(req("https://www.google.co.uk/ccm/collect?tid=AW-555&en=conversion&label=L1"), SITE);
  assert.equal(c.accountId, "AW-555");
});

test("Floodlight basic", () => {
  const [h] = decodeRequest(req("https://12345678.fls.doubleclick.net/activityi;src=12345678;type=sales0;cat=purch0;qty=1;cost=59.98;ord=T-1001;u1=blue;gcs=G101?"), SITE);
  assert.equal(h.vendor, "floodlight");
  assert.equal(h.accountId, "DC-12345678");
  assert.equal(h.eventName, "purch0");
  assert.equal(h.params.value, 59.98);
  assert.equal(h.params.ord, "T-1001");
  assert.equal(h.params.u1, "blue");
  assert.equal(h.consent?.keys.analytics_storage?.current, "granted");
  assert.equal(h.consent?.keys.ad_storage?.current, "denied");
});

test("Meta Purchase with eid via GET, ud[] presence only", () => {
  const url = "https://www.facebook.com/tr/?id=1122334455667788&ev=Purchase&eid=ord-T-1001&dl=https%3A%2F%2Fwww.example-shop.co.uk%2Fthanks" +
    "&cd[value]=59.98&cd[currency]=EUR&cd[content_type]=product&cd[content_ids]=%5B%22SKU-1%22%2C%22SKU-2%22%5D" +
    "&ud[em]=8b1a9953c4611296a827abf8c47804d7&ud[ph]=1234abcd";
  const [h] = decodeRequest(req(url), SITE);
  assert.equal(h.vendor, "meta");
  assert.equal(h.accountId, "1122334455667788");
  assert.equal(h.eventName, "Purchase");
  assert.equal(h.eventId, "ord-T-1001");
  assert.equal(h.params.value, 59.98);
  assert.equal(h.params.currency, "EUR");
  assert.deepEqual(h.params.content_ids, ["SKU-1", "SKU-2"]);
  assert.equal(h.params.advanced_matching, "present");
  assert.ok(!JSON.stringify(h).includes("8b1a9953"));
});

test("Meta POST urlencoded and multipart bodies", () => {
  const [a] = decodeRequest(req("https://www.facebook.com/tr/", { postData: "id=99&ev=Lead&eid=lead-1&cd%5Bvalue%5D=0" }), SITE);
  assert.equal(a.eventName, "Lead");
  assert.equal(a.eventId, "lead-1");
  assert.equal(a.params.value, 0);
  const b = "------WebKitFormBoundaryX\r\nContent-Disposition: form-data; name=\"id\"\r\n\r\n99\r\n" +
    "------WebKitFormBoundaryX\r\nContent-Disposition: form-data; name=\"ev\"\r\n\r\nPageView\r\n" +
    "------WebKitFormBoundaryX\r\nContent-Disposition: form-data; name=\"ud[em]\"\r\n\r\nhash\r\n" +
    "------WebKitFormBoundaryX--\r\n";
  const [m] = decodeRequest(req("https://www.facebook.com/tr/", { postData: b }), SITE);
  assert.equal(m.accountId, "99");
  assert.equal(m.eventName, "PageView");
  assert.equal(m.params.advanced_matching, "present");
});

test("LinkedIn collect and TikTok JSON", () => {
  const [li] = decodeRequest(req("https://px.ads.linkedin.com/collect?v=2&fmt=js&pid=123456&conversionId=7890&time=1"), SITE);
  assert.equal(li.vendor, "linkedin");
  assert.equal(li.accountId, "123456");
  assert.equal(li.eventName, "conversion");
  assert.equal(li.conversionLabel, "7890");
  const [lp] = decodeRequest(req("https://px.ads.linkedin.com/wa/", { postData: JSON.stringify({ pids: [123456], scriptVersion: 1 }) }), SITE);
  assert.equal(lp.accountId, "123456");
  assert.equal(lp.eventName, "page_view");

  const tt = {
    event: "CompletePayment", event_id: "T-1001",
    context: { pixel: { code: "CABC123" }, page: { url: "https://www.example-shop.co.uk/thanks" }, user: { email: "hash" } },
    properties: { value: 59.98, currency: "EUR", contents: [{ content_id: "SKU-1" }] },
  };
  const [t] = decodeRequest(req("https://analytics.tiktok.com/api/v2/pixel", { postData: JSON.stringify(tt) }), SITE);
  assert.equal(t.vendor, "tiktok");
  assert.equal(t.accountId, "CABC123");
  assert.equal(t.eventName, "CompletePayment");
  assert.equal(t.eventId, "T-1001");
  assert.equal(t.params.value, 59.98);
  assert.equal(t.params.advanced_matching, "present");
  assert.ok(Array.isArray(t.params.contents));
});

test("Microsoft UET", () => {
  const [u] = decodeRequest(req("https://bat.bing.com/action/0?ti=5555555&evt=custom&ea=purchase&gv=59.98&gc=EUR&asc=G"), SITE);
  assert.equal(u.vendor, "ms_uet");
  assert.equal(u.accountId, "5555555");
  assert.equal(u.eventName, "purchase");
  assert.equal(u.params.value, 59.98);
  assert.equal(u.params.currency, "EUR");
  const [pv] = decodeRequest(req("https://bat.bing.com/action/0?ti=5555555&evt=pageLoad"), SITE);
  assert.equal(pv.eventName, "page_view");
});

test("GTM container and gtag loads", () => {
  const [g] = decodeRequest(req("https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12"), SITE);
  assert.equal(g.vendor, "gtm");
  assert.equal(g.eventName, "container_load");
  assert.equal(g.accountId, "GTM-ABCD12");
  const [a] = decodeRequest(req("https://www.googletagmanager.com/gtag/js?id=AW-987654321&l=dataLayer"), SITE);
  assert.equal(a.vendor, "google_ads");
  assert.equal(a.eventName, "tag_load");
  const [ga] = decodeRequest(req("https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ"), SITE);
  assert.equal(ga.vendor, "ga4");
  const [fp] = decodeRequest(req("https://load.example-shop.co.uk/gtm.js?id=GTM-ABCD12"), SITE);
  assert.equal(fp.vendor, "gtm");
  assert.equal(fp.firstParty, true);
});

test("non-tracking and malformed requests decode to nothing, never throw", () => {
  assert.deepEqual(decodeRequest(req("https://www.example-shop.co.uk/"), SITE), []);
  assert.deepEqual(decodeRequest(req("not a url at all"), SITE), []);
  assert.deepEqual(decodeRequest(req("javascript:alert(1)"), SITE), []);
  assert.deepEqual(decodeRequest({} as CapturedRequest, SITE), []);
  assert.deepEqual(decodeRequest(null as unknown as CapturedRequest, SITE), []);
  // bad percent-encoding and garbage body
  const bad = decodeRequest(req("https://www.google-analytics.com/g/collect?v=2&tid=G-X1&en=page_view&dt=%E0%A4%A&pr1=%%%", { postData: "%%%\n\u0000en=x%ZZ" }), SITE);
  assert.ok(bad.length >= 1);
  assert.equal(bad[0].eventName, "page_view");
  assert.deepEqual(decodeRequest(req("https://analytics.tiktok.com/api/v2/pixel", { postData: "{not json" }), SITE), []);
  // oversized body is capped, not fatal
  const big = "en=page_view\n" + "x".repeat(200_000);
  assert.equal(decodeRequest(req("https://www.google-analytics.com/g/collect?v=2&tid=G-X1", { postData: big }), SITE).length, 1);
});

test("decodeAll flattens", () => {
  const hits = decodeAll([
    req("https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12"),
    req("https://www.example-shop.co.uk/style.css"),
    req(GA4_BASE, { postData: "en=a\nen=b" }),
  ], SITE);
  assert.equal(hits.length, 3);
});

test("registrable domain and first-party", () => {
  assert.equal(registrableDomain("a.b.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("shop.example.com.tn"), "example.com.tn");
  assert.equal(registrableDomain("www.example.com"), "example.com");
  assert.equal(registrableDomain("https://www.example.com:8443/x"), "example.com");
  assert.ok(isFirstParty("sgtm.example.com", "www.example.com"));
  assert.ok(!isFirstParty("example.co.uk", "other.co.uk"));
  assert.ok(!isFirstParty("www.google-analytics.com", "www.example.com"));
});
