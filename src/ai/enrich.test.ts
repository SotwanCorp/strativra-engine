import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleReport } from "../report/fixtures/sample-report.ts";
import { GA4_VOCAB, META_VOCAB, enrichReport } from "./enrich.ts";
import { FakeClaude, FakeJev, sampleCapture } from "./fakes.test-util.ts";

test("no deps: identity report + deterministic plan, no numbers in plan text", async () => {
  const before = structuredClone(sampleReport);
  const res = await enrichReport(sampleReport, sampleCapture());
  assert.deepEqual({ ...res.report, plan: undefined }, { ...sampleReport, plan: undefined });
  assert.equal(res.report.plan, res.plan, "plan is attached to the report");
  assert.deepEqual(sampleReport, before, "input not mutated");
  assert.equal(res.narrative, undefined);
  assert.equal(res.plan.businessModel.value, "ecommerce");
  assert.equal(res.plan.businessModel.source, "rules");
  assert.ok(res.plan.conversions.some((c) => c.type === "purchase" && c.status === "partial"));
  assert.equal(res.plan.events.find((e) => e.name === "purchase")?.status, "seen", "purchase seen in the dataLayer");
  assert.equal(res.plan.events.find((e) => e.name === "begin_checkout")?.status, "unknown", "step was not walked, so not missing");
  for (const c of res.plan.conversions) assert.ok(!/\d/.test(c.why));
  assert.equal(res.usage.jevCalls + res.usage.claudeCalls, 0);
});

test("with fakes: one Jev batch, ladder on ambiguous points, severity within one level, locked narration", async () => {
  const jev = new FakeJev({
    answer: (name) => {
      if (name === "bm") return { type: "choice", choice: "ecommerce", confidence: 0.92, probabilities: { ecommerce: 0.92 } };
      if (name === "cp0_real") return { type: "choice", choice: "yes", confidence: 0.6, probabilities: { yes: 0.6, no: 0.4 } };
      if (name === "cp0_type") return { type: "choice", choice: "lead", confidence: 0.9, probabilities: { lead: 0.9 } };
      // first open finding (critical): all axes 0 -> composite low -> clamped to high
      if (name.startsWith("f0_")) return { type: "score", score: 0.1, confidence: 0.9, legend: {}, probabilities: { "0": 0.9, "1": 0.1 } } as never;
      if (name.startsWith("f1_")) return { type: "score", score: 3, confidence: 0.5, legend: {}, probabilities: { "3": 1 } } as never; // unsure: no change
      if (/^c\d+$/.test(name)) return { type: "choice", choice: "supports", confidence: 0.95, probabilities: { supports: 0.95 } };
      return undefined;
    },
  });
  const claude = new FakeClaude((params) => {
    const user = JSON.stringify(params.messages);
    if (user.includes("Task: decide")) return { answer: "yes", confidence: 0.9, evidenceIds: ["cp:cp2"], rationale: "Contact form." };
    if (user.includes("tracking plan"))
      return {
        businessModel: "ecommerce",
        conversions: [{ type: "purchase", why: { text: "This shop sells products, so orders are the main goal.", evidenceIds: ["r"] } }],
        events: [{ name: "add_payment_info", vendor: "ga4", conversionType: "purchase" }, { name: "made_up_event", vendor: "ga4", conversionType: null }],
      };
    return {
      summary: [{ text: "Tags fire before consent.", evidenceIds: ["f:consent.fires_before_consent"] }],
      findings: [{ id: "consent.fires_before_consent", why: { text: "A page_view hit was sent before consent.", evidenceIds: ["h1"] }, fix: { text: "Set consent defaults to denied.", evidenceIds: ["f:consent.fires_before_consent"] } }],
    };
  });

  const res = await enrichReport(sampleReport, sampleCapture(), { jev, claude }, "free");

  // stage batch + gate-2 batches (narrate, plan); judge batch first
  assert.ok(jev.calls.length >= 1 && jev.calls.length <= 3);
  const q0 = Object.keys(jev.calls[0].questions);
  assert.ok(q0.includes("bm") && q0.includes("cp0_real") && q0.includes("cp0_type") && q0.includes("f0_dataLoss"));
  assert.ok(!q0.some((k) => k.startsWith("cp1")), "confident conversion points are not asked");
  assert.ok(!JSON.stringify(jev.calls).includes("jane"), "Jev gets redacted state only");

  // ladder: Jev 0.6 < 0.8 -> Claude (free, within budget) -> 0.9 accepted
  const cp = res.judgments.conversionPoints["cp2"];
  assert.equal(cp.real.tier, "claude");
  assert.equal(cp.real.value, true);
  assert.equal(cp.type?.value, "lead");

  // severity: critical -> high (one level max), unsure one unchanged
  assert.equal(res.report.findings[0].severity, "high");
  assert.equal(res.report.findings[1].severity, sampleReport.findings[1].severity);
  assert.equal(res.report.counts.critical, 0);
  assert.equal(sampleReport.findings[0].severity, "critical", "input not mutated");

  // narration under the lock
  assert.equal(res.report.findings[0].why, "A page_view hit was sent before consent.");
  assert.equal(res.report.findings[1].why, sampleReport.findings[1].why, "missing claim -> rules text");
  assert.equal(res.narrative!.summary[0].source, "ai");

  // plan: Jev business model, vocabulary only, statuses in code
  assert.equal(res.plan.businessModel.source, "jev");
  assert.ok(res.plan.events.some((e) => e.name === "add_payment_info" && e.status === "unknown"));
  assert.ok(!res.plan.events.some((e) => e.name === "made_up_event"));
  for (const e of res.plan.events) assert.ok(e.vendor === "ga4" ? GA4_VOCAB.has(e.name) : META_VOCAB.has(e.name));
  assert.equal(res.plan.conversions.find((c) => c.type === "purchase")?.why, "This shop sells products, so orders are the main goal.");
  assert.equal(res.report.plan, res.plan);
  assert.ok(res.usage.claudeCalls >= 3 && res.usage.usd > 0);
});

test("free: Jev unsure and no Claude -> needs a closer look", async () => {
  const jev = new FakeJev({ confidence: 0.5 });
  const res = await enrichReport(sampleReport, sampleCapture(), { jev }, "free");
  assert.deepEqual(res.needsCloserLook, ["cp2"]);
  assert.deepEqual(res.report.findings.map((f) => f.severity), sampleReport.findings.map((f) => f.severity));
});

test("paid: unresolved goes to owner review", async () => {
  const jev = new FakeJev({ confidence: 0.5 });
  const claude = new FakeClaude(() => ({ answer: "no", confidence: 0.4, evidenceIds: ["cp:cp2"], rationale: "" }));
  const res = await enrichReport({ ...sampleReport, kind: "paid" }, sampleCapture(), { jev, claude }, "paid");
  assert.deepEqual(res.review, ["cp2"]);
});
