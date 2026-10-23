import { test } from "node:test";
import assert from "node:assert/strict";
import { APITimeoutError, RateLimitError, TypeSafeClient } from "@typesafe-ai/sdk";
import { ScanBudget } from "./budget.ts";
import { AiJudge, type JevClient, argmaxLevel, clampOneLevel, compositeSeverity, fromScore } from "./judge.ts";
import { makeItem } from "./redact.ts";
import { FakeJev } from "./fakes.test-util.ts";

const items = [makeItem("h1", "hit", "GA4 page_view (none, pre)", { event: "page_view", email: "a@b.co" })];

test("a real TypeSafeClient satisfies JevClient (type check)", () => {
  const c: JevClient = new TypeSafeClient({ apiKey: "test-key", compression: false });
  assert.ok(c);
});

test("batch: one request per call, redacted state only", async () => {
  const jev = new FakeJev();
  const judge = new AiJudge(jev);
  await judge.yesNo(items, "Is this a page view?", { fallback: false });
  assert.equal(jev.calls.length, 1);
  assert.ok(!JSON.stringify(jev.calls[0]).includes("a@b.co"));
});

test("yesNo default is a 2-option choice with Jev confidence", async () => {
  const j = await new AiJudge(new FakeJev({ confidence: 0.9 })).yesNo(items, "q", { fallback: false });
  assert.deepEqual([j.value, j.confidence, j.tier], [true, 0.9, "jev"]);
});

test("yesNo via noul: confidence = |p - 0.5| * 2", async () => {
  const jev = new FakeJev({ answer: () => ({ type: "noul", noul: 0.2 }) });
  const j = await new AiJudge(jev).yesNo(items, "q", { fallback: true, via: "noul" });
  assert.equal(j.value, false);
  assert.ok(Math.abs(j.confidence - 0.6) < 1e-9);
});

test("pick and rate", async () => {
  const judge = new AiJudge(new FakeJev());
  const p = await judge.pick(items, "type?", { lead: null, purchase: null }, { fallback: "purchase" });
  assert.equal(p.value, "lead");
  const r = await judge.rate(items, "how bad?", ["none", "minor", "significant", "severe"], { fallback: 0 });
  assert.equal(r.value, 1.02);
  assert.equal(r.detail!.level, 1);
});

test("score keeps the float, level = argmax of probabilities", () => {
  const j = fromScore({ type: "score", score: 2.98, confidence: 1, legend: {}, probabilities: { "0": 0, "1": 0, "2": 0.02, "3": 0.98 } } as never, ["h1"]);
  assert.equal(j!.value, 2.98);
  assert.equal(j!.detail!.level, 3);
  assert.equal(argmaxLevel(undefined, 1.6), 2);
});

test("SDK errors become degraded results, never throws", async () => {
  const rl = await new AiJudge(new FakeJev({ throws: new RateLimitError(429, {}, new Headers()) })).yesNo(items, "q", { fallback: true });
  assert.deepEqual([rl.value, rl.confidence, rl.degraded], [true, 0, "rate_limit"]);
  const to = await new AiJudge(new FakeJev({ throws: new APITimeoutError(10_000) })).pick(items, "q", { a: null, b: null }, { fallback: "b" });
  assert.deepEqual([to.value, to.degraded], ["b", "timeout"]);
  const none = await new AiJudge(undefined).yesNo(items, "q", { fallback: false });
  assert.equal(none.degraded, "no_client");
});

test("budget cap stops Jev calls", async () => {
  const jev = new FakeJev();
  const judge = new AiJudge(jev, { budget: new ScanBudget({ tier: "free", limits: { maxJevCalls: 1 } }) });
  await judge.yesNo(items, "q", { fallback: false });
  const second = await judge.yesNo(items, "q", { fallback: false });
  assert.equal(jev.calls.length, 1);
  assert.equal(second.degraded, "budget");
});

test("severity: weighted composite, deterministic, max one level from rules", async () => {
  assert.deepEqual(compositeSeverity({ dataLoss: 3, attribution: 3, compliance: 3, reach: 3 }), { level: "critical", composite: 3 });
  assert.deepEqual(compositeSeverity({ dataLoss: 0, attribution: 0, compliance: 0, reach: 0 }), { level: "low", composite: 0 });
  assert.equal(clampOneLevel("low", "critical"), "medium");
  assert.equal(clampOneLevel("critical", "low"), "high");
  const sev = await new AiJudge(new FakeJev({ answer: () => ({ type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: { "3": 1 } }) as never })).severity(
    { id: "x", title: "t", severity: "low" },
    items,
  );
  assert.equal(sev.value, "medium");
  assert.equal(sev.detail!.composite, 3);
  assert.equal(sev.confidence, 0.9);
});

test("supports gate returns the label and confidence", async () => {
  const j = await new AiJudge(new FakeJev({ confidence: 0.85 })).supports("A page_view hit fired.", items);
  assert.deepEqual([j.value, j.confidence], ["supports", 0.85]);
});
