import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleReport } from "../report/fixtures/sample-report.ts";
import { buildEvidenceIndex, redactText, redactUrl, redactValue } from "./redact.ts";
import { sampleCapture } from "./fakes.test-util.ts";

test("redactText strips emails, phones and long tokens", () => {
  const s = redactText("mail jane.doe@example.org or jane%40example.org, call +33 6 12 34 56 78 or 06 12 34 56 78, hash 7d3b8c1f00aa11bb22cc33dd44ee55ff66778899aabbccddeeff001122334455");
  assert.ok(!s.includes("jane"), s);
  assert.ok(!s.includes("12 34"), s);
  assert.ok(!s.includes("7d3b8c1f"), s);
  assert.match(s, /\[email\].*\[phone\]/);
});

test("redactText keeps pixel ids, event names and plain values", () => {
  assert.equal(redactText("pixel 000000000000000 sent purchase value 49.9"), "pixel 000000000000000 sent purchase value 49.9");
});

test("redactUrl drops client/user ids and PII params, keeps tracking params", () => {
  const u = redactUrl("https://www.google-analytics.com/g/collect?v=2&tid=G-TEST0000&en=page_view&cid=1234567890.1700000000&uid=u1&_ga=GA1.1.1.2&gclid=abc&q=jane@example.org");
  assert.ok(u.includes("tid=G-TEST0000") && u.includes("en=page_view"));
  for (const bad of ["cid=", "uid=", "_ga=", "gclid=", "jane", "1234567890"]) assert.ok(!u.includes(bad), `${bad} in ${u}`);
});

test("redactValue redacts by key (cookie values, ids, contact data) and caps size", () => {
  const v = redactValue({ cookie: "_ga=GA1.1.123456789.1700000000", user_id: "u-1", em: "abc", event: "purchase", items: Array.from({ length: 30 }, (_, i) => i) }) as Record<string, unknown>;
  assert.equal(v.cookie, "[redacted]");
  assert.equal(v.user_id, "[redacted]");
  assert.equal(v.em, "[redacted]");
  assert.equal(v.event, "purchase");
  assert.equal((v.items as unknown[]).length, 11);
  assert.equal(redactText("x".repeat(500)).length, 200);
});

test("evidence index has no PII and stable ids", () => {
  const { index, refToId } = buildEvidenceIndex({ report: sampleReport, capture: sampleCapture(), tier: "paid" });
  const all = JSON.stringify([...index.values()]);
  for (const bad of ["jane", "example.org", "+33", "12 34 56", "1234567890.1700000000", "user-8842", "7d3b8c1f", "987654321"]) assert.ok(!all.includes(bad), bad);
  assert.equal(refToId.get("req-014"), "h1");
  assert.ok(index.has("r") && index.has("t1") && index.has("d1") && index.has("c1") && index.has("s1") && index.has("p1") && index.has("cp:cp2"));
  assert.ok(index.has("f:consent.fires_before_consent"));
  assert.ok(!all.includes("cdn.example-shop.test"), "non-tracking requests are left out");
  // the cookie item has a name and a domain only
  assert.deepEqual(Object.keys(index.get("c1")!.data as object).sort(), ["domain", "firstParty", "name", "phase", "scenario"]);
  for (const it of index.values()) assert.ok(Buffer.byteLength(JSON.stringify(it.data ?? null)) <= 1500);
});

test("free index hides locked findings' evidence and fix", () => {
  const { index, lockedFindingIds } = buildEvidenceIndex({ report: sampleReport, capture: sampleCapture(), tier: "free" });
  assert.ok(lockedFindingIds.has("gads.no_enhanced_conversions"));
  const all = JSON.stringify([...index.values()]);
  assert.ok(!all.includes("abc123"), "locked hit req-051 must not be indexed");
  assert.ok(!all.includes("Turn on enhanced conversions"), "locked fix must not be indexed");
  const stub = index.get("f:gads.no_enhanced_conversions")!.data as Record<string, unknown>;
  assert.deepEqual(stub, { title: "Google Ads conversion sent without enhanced conversions", severity: "medium", locked: true });
});
