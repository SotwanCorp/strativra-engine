import { test } from "node:test";
import assert from "node:assert/strict";
import { basePattern, mapResourceType, originsToRemove, RECORDING_ORIGINS, recordableUrl, shouldKeepBody, siteMatchPatterns } from "./record.ts";
import { TEMPLATES } from "./templates.ts";

test("bodies only for tracking destinations and first-party collect paths", () => {
  assert.equal(shouldKeepBody("https://www.google-analytics.com/g/collect?v=2&tid=G-1", "POST"), true);
  assert.equal(shouldKeepBody("https://shop.example/g/collect?v=2&tid=G-1&en=x", "POST"), true);
  assert.equal(shouldKeepBody("https://www.facebook.com/tr/", "POST"), true);
  assert.equal(shouldKeepBody("https://shop.example/api/lead", "POST"), false);
  assert.equal(shouldKeepBody("https://shop.example/cart/add.js", "POST"), false);
  assert.equal(shouldKeepBody("https://www.google-analytics.com/g/collect?v=2&tid=G-1", "GET"), false);
});

test("resource types map to the engine's names", () => {
  assert.equal(mapResourceType("main_frame"), "document");
  assert.equal(mapResourceType("sub_frame"), "sub_frame");
  assert.equal(mapResourceType("xmlhttprequest"), "xhr");
  assert.equal(mapResourceType("ping"), "ping");
  assert.equal(mapResourceType("weird"), "other");
});

test("content scripts match the site's registrable domain only", () => {
  assert.deepEqual(siteMatchPatterns("https://www.shop.example/p?x=1"), ["https://shop.example/*", "https://*.shop.example/*"]);
  assert.deepEqual(siteMatchPatterns("https://shop.co.uk/"), ["https://shop.co.uk/*", "https://*.shop.co.uk/*"]);
  assert.deepEqual(siteMatchPatterns("http://127.0.0.1:8080/"), ["http://127.0.0.1/*"]);
  assert.deepEqual(siteMatchPatterns("http://intranet/"), ["http://intranet/*"]);
});

test("recordable tabs are http(s) pages, not the Web Store", () => {
  assert.ok(recordableUrl("https://shop.example/"));
  assert.equal(recordableUrl("chrome://extensions"), null);
  assert.equal(recordableUrl("https://chromewebstore.google.com/detail/x"), null);
  assert.equal(recordableUrl(undefined), null);
});

test("after upload: recording origins go, required ones and the API base stay", () => {
  const granted = ["https://strativra.com/*", ...RECORDING_ORIGINS, "http://127.0.0.1/*"];
  assert.deepEqual(originsToRemove(granted, ["https://strativra.com/*", basePattern("http://127.0.0.1:8890")]), RECORDING_ORIGINS);
  assert.deepEqual(originsToRemove(granted, [...granted]), []);
});

test("templates: last step is 'Stop before you submit or pay', step names are snake_case", () => {
  for (const t of Object.values(TEMPLATES)) {
    const last = t.steps[t.steps.length - 1];
    assert.equal(last.final, true);
    assert.equal(last.label, "Stop before you submit or pay");
    assert.equal(t.steps.filter((s) => s.final).length, 1);
    for (const s of t.steps) assert.match(s.name, /^[a-z][a-z0-9_]{0,39}$/);
  }
  assert.deepEqual(TEMPLATES.ecommerce.steps.map((s) => s.name), ["view_item", "add_to_cart", "begin_checkout", "stopped"]);
  assert.ok(TEMPLATES.lead.steps.some((s) => s.name === "form_start"));
});
