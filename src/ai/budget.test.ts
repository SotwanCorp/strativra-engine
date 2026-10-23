import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleReport } from "../report/fixtures/sample-report.ts";
import { DailyBreaker, MemorySpendStore, ScanBudget, claudeCostUsd } from "./budget.ts";
import { enrichReport } from "./enrich.ts";
import { FakeClaude, FakeJev, sampleCapture } from "./fakes.test-util.ts";

test("cost accounting from usage", () => {
  const usd = claudeCostUsd("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 });
  assert.equal(Math.round(usd * 100) / 100, 24.2);
});

test("per-scan caps: Jev calls and Claude tokens", () => {
  const b = new ScanBudget({ tier: "free", limits: { maxJevCalls: 1, maxClaudeTokens: 1000 } });
  assert.equal(b.allowJev(), true);
  b.recordJev({ input_tokens: 10, output_tokens: 1 });
  assert.equal(b.allowJev(), false);
  assert.equal(b.allowClaude(900), true);
  b.recordClaude("claude-haiku-5-5", { input_tokens: 800, output_tokens: 100 });
  assert.equal(b.allowClaude(200), false);
  assert.equal(b.usage.degraded, true);
  assert.equal(b.usage.skipped, 2);
});

test("global daily breaker trips across scans and resets the next day", () => {
  let now = new Date("2026-10-23T10:00:00Z");
  const store = new MemorySpendStore();
  const breaker = new DailyBreaker({ maxUsdPerDay: 1, store, now: () => now });
  const a = new ScanBudget({ tier: "paid", breaker });
  a.recordClaude("claude-opus-5-5", { input_tokens: 100_000, output_tokens: 40_000 }); // 0.4 + 0.8 = 1.2 USD
  const b = new ScanBudget({ tier: "paid", breaker });
  assert.equal(b.allowJev(), false);
  assert.equal(b.allowClaude(10), false);
  now = new Date("2026-10-24T00:00:01Z");
  assert.equal(b.allowJev(), true);
});

test("tripped breaker: enrichReport degrades to the deterministic report, no AI calls", async () => {
  const store = new MemorySpendStore();
  store.add("2026-10-23", 999);
  const breaker = new DailyBreaker({ maxUsdPerDay: 5, store, now: () => new Date("2026-10-23T12:00:00Z") });
  const jev = new FakeJev();
  const claude = new FakeClaude(() => ({}));
  const res = await enrichReport(sampleReport, sampleCapture(), { jev, claude, breaker }, "free");
  assert.equal(jev.calls.length, 0);
  assert.equal(claude.calls.length, 0);
  assert.deepEqual(res.report, sampleReport);
  assert.equal(res.usage.degraded, true);
  // nothing AI-specific leaks into the report or narrative
  assert.ok(!JSON.stringify(res.report).match(/\bAI\b|budget|model/i));
  for (const c of res.narrative!.summary) assert.equal(c.source, "template");
});
