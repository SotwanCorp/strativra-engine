/**
 * A recording as the Chrome extension would upload it (before redaction), for upload and worker tests.
 * Not a test file itself.
 */
export const CLEAN_COOKIE_VALUE = "GA1.1.SECRETVALUE";

/** Deliberately full of PII, to prove none of it survives. */
export function uploadBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const shop = "https://shop.example/";
  const ga = (gcs: string, extra: string) => `https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST1${gcs}&_p=999&sid=1761300000${extra}`;
  return {
    source: "extension",
    trigger: "upload",
    accountRef: "acc_42",
    siteRef: "site-7",
    ai: false,
    clientVersion: "1.0.0",
    consentMarkerTs: 2000,
    guidedSteps: [
      { name: "view_item", action: "Opened a product page", ts: 1000, pageUrl: `${shop}product/mug` },
      { name: "Add to cart", action: "Clicked add to cart as john.doe@example.com", ts: 3100, pageUrl: `${shop}product/mug`, ok: true },
      { name: "begin_checkout", action: "Skipped, no checkout button", ts: 3500, ok: false },
      { name: "stop_before_submit", action: "Stopped before paying", ts: 4000 },
    ],
    capture: {
      target: shop,
      finalUrl: shop,
      region: "Somewhere else",
      startedAt: "2026-10-25T10:00:00.000Z",
      durationMs: 20000,
      userAgent: "Mozilla/5.0 test",
      leakedField: "dropped",
      pages: [{ url: shop, status: 200, via: "start", title: "Mugs for jane@example.com" }],
      platformHints: ["Shopify"],
      scenarios: [
        {
          scenario: "accept",
          banner: "clicked",
          cmp: "Cookiebot",
          requests: [
            { id: "a1", ts: 100, url: "https://www.googletagmanager.com/gtag/js?id=G-TEST1", pageUrl: shop, method: "GET", resourceType: "script" },
            // before the consent click (ts < 2000), no phase given: derived from the marker
            { id: "a2", ts: 300, url: ga("", "&en=page_view&cid=1234567890.1234567890&uid=abc&dl=https%3A%2F%2Fshop.example%2F%3Femail%3Djohn%40example.com&dr="), pageUrl: shop, method: "POST", resourceType: "ping", postData: "en=scroll&ep.email=jane%40example.com&ep.percent_scrolled=90&cid=777" },
            // after the click
            { id: "a3", ts: 3000, url: ga("&gcs=G111", "&en=add_to_cart&cu=EUR&epn.value=12"), pageUrl: `${shop}product/mug`, method: "POST", resourceType: "ping", postData: "en=add_to_cart&ep.user_email=a%40b.co&pr1=idMUG1~nmMug~pr12" },
            // a form POST to the site itself: tracking-looking nothing, body must not be kept
            { id: "a4", ts: 3200, url: `${shop}wp-admin/admin-ajax.php`, pageUrl: shop, method: "POST", resourceType: "xhr", postData: "name=John&email=john%40example.com&phone=%2B21612345678" },
            { id: "a5", ts: 3300, url: "https://www.facebook.com/tr/?id=123456789012345&ev=PageView&eid=evt1&ud%5Bem%5D=hashedvalue&fbp=fb.1.1.2", pageUrl: shop, method: "GET", resourceType: "image" },
            { ts: 3400, url: "https://user:secret@tracker.example/p?token=abc&x=1#section-token", pageUrl: shop },
            { ts: 3500, url: "data:image/gif;base64,R0lGOD", pageUrl: shop },
          ],
          dataLayer: [
            { ts: 500, pageUrl: shop, payload: { event: "gtm.js" } },
            { ts: 3200, pageUrl: shop, payload: { event: "add_to_cart", email: "x@y.com", user_id: "u1", transaction_id: "1234567890123", note: "call +216 12 345 678 now", nested: { contact: "me@site.org" } } },
          ],
          cookies: [
            { name: "_ga", domain: ".shop.example", firstParty: true, value: CLEAN_COOKIE_VALUE },
            { name: "_fbp", domain: ".shop.example", firstParty: true, phase: "post", value: "fb.1.SECRET" },
          ],
          screenshots: [{ key: "s.png", caption: "x", pageUrl: shop, scenario: "accept" }],
          errors: ["failed for bob@example.com"],
          gtagConsent: { pre: { ad_storage: "granted", bogus: "x" }, post: { analytics_storage: "granted" } },
        },
      ],
    },
    ...over,
  };
}

/** A minimal valid body with `n` plain requests, for cap tests. */
export function bodyWithRequests(n: number): Record<string, unknown> {
  const requests = Array.from({ length: n }, (_, i) => ({ ts: i, url: `https://cdn.example/a${i}.js`, pageUrl: "https://shop.example/" }));
  return {
    capture: {
      target: "https://shop.example/",
      startedAt: "2026-10-25T10:00:00.000Z",
      durationMs: 1000,
      scenarios: [{ scenario: "none", banner: "no_banner", requests }],
    },
  };
}
