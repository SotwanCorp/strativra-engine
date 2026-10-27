import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleReport } from "../report/fixtures/sample-report.ts";
import { redactForFree } from "../core/report.ts";
import type { Capture, ConversionType, Finding, Report } from "../types.ts";
import { enrichReport } from "./enrich.ts";
import { sampleCapture } from "./fakes.test-util.ts";

/** A lead-gen site: contact form + email link, nothing else. */
function leadSite(opts: { tagsFailed?: boolean; walkFormStart?: boolean } = {}): { report: Report; capture: Capture } {
  const capture = sampleCapture();
  const mkCp = (id: string, type: ConversionType, walk: Capture["conversionPoints"][number]["walk"] = []) => ({
    id, type, pageUrl: "https://example-agency.test/contact", label: id, detectedBy: "generic", confidence: 0.95, walk,
  });
  capture.conversionPoints = [
    mkCp("cp1", "lead", opts.walkFormStart ? [{ name: "form_start", action: "focused message field", ok: true, pageUrl: "https://example-agency.test/contact", ts: 1, scenario: "none" }] : []),
    mkCp("cp2", "contact_click"),
  ];
  const findings: Finding[] = opts.tagsFailed ? [{ ...sampleReport.findings[0]!, id: "scan.tag_library_failed", reproduced: false, evidence: [] }] : [];
  if (opts.tagsFailed) {
    // No hit ever left the browser when tags fail to load.
    for (const s of capture.scenarios) s.requests = s.requests.filter((r) => !/google-analytics|facebook|googleadservices/.test(r.url));
    for (const s of capture.scenarios) s.dataLayer = [];
  }
  const report: Report = {
    ...structuredClone(sampleReport),
    findings,
    open: [],
    stack: [{ vendor: "platform", name: "WordPress", ids: [], source: "html" }],
    conversions: [
      { type: "lead", points: ["cp1"], status: opts.tagsFailed ? "not_testable" : "not_tracked", summary: "Lead" },
      { type: "contact_click", points: ["cp2"], status: opts.tagsFailed ? "not_testable" : "not_tracked", summary: "Contact" },
    ],
  };
  return { report, capture };
}

const types = (r: Report) => r.plan!.conversions.map((c) => c.type);

test("lead_gen site: lists lead and contact_click, never purchase, booking, signup or download", async () => {
  const { report, capture } = leadSite();
  const res = await enrichReport(report, capture);
  assert.equal(res.plan.businessModel.value, "lead_gen");
  assert.deepEqual(types(res.report).sort(), ["contact_click", "lead"]);
  assert.ok(!res.plan.events.some((e) => e.conversionType === "purchase" || e.name === "purchase"));
  assert.deepEqual(res.report.plan, res.plan);
});

test("ecommerce site: purchase is listed, lead only because a form was detected", async () => {
  const res = await enrichReport(sampleReport, sampleCapture());
  assert.equal(res.plan.businessModel.value, "ecommerce");
  assert.ok(types(res.report).includes("purchase"));
  const shop = structuredClone(sampleReport);
  shop.conversions = [{ type: "purchase", points: ["cp1"], status: "ok", summary: "ok" }];
  const cap = sampleCapture();
  cap.conversionPoints = cap.conversionPoints.filter((c) => c.type === "purchase");
  assert.deepEqual(types((await enrichReport(shop, cap)).report), ["purchase"]);
});

test("nothing detected on an unclassifiable site: no conversions are invented", async () => {
  const { report, capture } = leadSite();
  report.conversions = [];
  capture.conversionPoints = [];
  const res = await enrichReport(report, capture);
  assert.equal(res.plan.businessModel.value, "other");
  assert.deepEqual(res.plan.conversions, []);
});

test("tags failed to load: nothing is 'missing', everything untested is 'unknown'", async () => {
  const { report, capture } = leadSite({ tagsFailed: true, walkFormStart: true });
  const res = await enrichReport(report, capture);
  assert.ok(res.plan.conversions.every((c) => c.status === "unknown"));
  assert.ok(res.plan.events.length > 0 && res.plan.events.every((e) => e.status === "unknown"));
  assert.ok(res.plan.conversions.every((c) => /did not load/.test(c.why)));
});

test("tags loaded: 'missing' only when the step was walked; final steps stay 'unknown'", async () => {
  const walked = await enrichReport(...Object.values(leadSite({ walkFormStart: true })) as [Report, Capture]);
  const ev = (n: string) => walked.plan.events.find((e) => e.name === n)?.status;
  assert.equal(ev("form_start"), "missing", "tags loaded and the step was exercised");
  assert.equal(ev("generate_lead"), "unknown", "we never submit, so the final event is not testable");
  const notWalked = await enrichReport(...Object.values(leadSite()) as [Report, Capture]);
  assert.equal(notWalked.plan.events.find((e) => e.name === "form_start")?.status, "unknown");
});

test("event seen in a hit is 'seen'", async () => {
  const res = await enrichReport(sampleReport, sampleCapture());
  assert.equal(res.plan.events.find((e) => e.name === "purchase" && e.vendor === "ga4")?.status, "seen");
});

test("plan text has no dashes, digits or prices; plan survives redactForFree", async () => {
  const res = await enrichReport(sampleReport, sampleCapture());
  const text = JSON.stringify(res.plan);
  assert.ok(!/[–—]/.test(text));
  for (const c of res.plan.conversions) assert.ok(!/\d|[$€£]/.test(c.why));
  assert.deepEqual(redactForFree(res.report).plan, res.plan);
});
