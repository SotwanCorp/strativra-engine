import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, redactForFree } from "./report.ts";
import { cleanSite, leadSite, shopSite, tagsBeforeConsent } from "./rules/fixtures.ts";

const now = new Date("2026-10-23T12:00:00Z");

test("free shop report: stack, conversions, open top 3, counts, redaction", () => {
  const { capture, hits } = shopSite();
  const r = buildReport(capture, hits, "free", "rep1", { now });
  assert.equal(r.generatedAt, "2026-10-23T12:00:00.000Z");
  assert.deepEqual(r.stack.map((s) => s.name), ["Google Analytics 4", "Meta Pixel", "Cookiebot", "Shopify"]);
  assert.deepEqual(r.stack[0].ids, ["G-SHOP1"]);
  assert.equal(r.conversions[0].type, "purchase");
  assert.equal(r.conversions[0].status, "broken");
  assert.equal(r.open.length, 3);
  assert.deepEqual(r.counts, { critical: 0, high: 2, medium: 1, low: 0 });
  assert.equal(Object.keys(r.rankNotes).length, 3);
  assert.equal(r.scan.banner.accept, "clicked");

  const red = redactForFree(r);
  for (const f of red.findings) {
    if (r.open.includes(f.id)) assert.ok(f.evidence.length > 0 && f.fix.steps.length > 0);
    else assert.ok(f.evidence.length === 0 && f.fix.steps.length === 0 && f.title && f.why);
  }
});

test("free lead report locks the unreproduced finding but keeps title and why", () => {
  const { capture, hits } = leadSite();
  const r = redactForFree(buildReport(capture, hits, "free", "rep2", { now }));
  assert.deepEqual(r.open, ["conversion.form_start_missing"]);
  const locked = r.findings.find((f) => f.id === "conversion.final_event_unverified");
  assert.ok(locked && locked.title && locked.severity === "medium" && locked.evidence.length === 0);
  assert.equal(r.conversions[0].status, "partial");
});

test("paid report opens everything and is not redacted", () => {
  const { capture, hits } = tagsBeforeConsent();
  const r = buildReport(capture, hits, "paid", "rep3", { now });
  assert.equal(r.open.length, r.findings.length);
  assert.equal(redactForFree(r), r);
});

test("clean site: ok contact clicks, no findings", () => {
  const { capture, hits } = cleanSite();
  const r = buildReport(capture, hits, "free", "rep4", { now });
  assert.equal(r.findings.length, 0);
  assert.equal(r.conversions[0].status, "ok");
});

test("aborted scan: not testable, no findings", () => {
  const { capture, hits } = shopSite();
  capture.aborted = { reason: "bot_protection", detail: "challenge" };
  const r = buildReport(capture, hits, "free", "rep5", { now });
  assert.equal(r.findings.length, 0);
  assert.equal(r.conversions[0].status, "not_testable");
  assert.equal(r.scan.aborted?.reason, "bot_protection");
});
