import { test } from "node:test";
import assert from "node:assert/strict";
import { ScanBudget } from "./budget.ts";
import { decide } from "./ladder.ts";
import type { Judgment } from "./types.ts";

const j = <T>(value: T, confidence: number, tier: Judgment<T>["tier"] = "jev"): Judgment<T> => ({ value, confidence, tier, evidenceIds: ["r"] });

function spy<T>(res: Judgment<T>) {
  const s = { calls: 0, fn: async () => (s.calls++, res) };
  return s;
}

test("rules confident -> rules, nothing else runs", async () => {
  const jev = spy(j("lead", 0.99));
  const out = await decide({ fallback: "x", tier: "free", rules: () => j("purchase", 0.9, "rules"), jev: jev.fn });
  assert.equal(out.tier, "rules");
  assert.equal(out.value, "purchase");
  assert.equal(jev.calls, 0);
});

test("Jev at threshold -> accepted, Claude not called", async () => {
  const claude = spy(j("x", 1, "claude"));
  const out = await decide({ fallback: "x", tier: "paid", rules: () => undefined, jev: async () => j("lead", 0.8), claude: claude.fn });
  assert.equal(out.tier, "jev");
  assert.equal(out.value, "lead");
  assert.equal(claude.calls, 0);
});

test("paid: Jev unsure -> Claude always", async () => {
  const out = await decide({ fallback: "x", tier: "paid", jev: async () => j("lead", 0.4), claude: async () => j("booking", 0.9, "claude") });
  assert.equal(out.tier, "claude");
  assert.equal(out.value, "booking");
});

test("paid: nobody confident -> owner review with best guess", async () => {
  const out = await decide({ fallback: "x", tier: "paid", jev: async () => j("lead", 0.6), claude: async () => j("booking", 0.5, "claude") });
  assert.equal(out.tier, "review");
  assert.equal(out.value, "lead");
  assert.equal(out.needsCloserLook, undefined);
});

test("free: Claude only within budget, else needs a closer look", async () => {
  const budget = new ScanBudget({ tier: "free", limits: { maxClaudeTokens: 10 } });
  const claude = spy(j("booking", 0.99, "claude"));
  const out = await decide({ fallback: "x", tier: "free", budget, jev: async () => j("lead", 0.5), claude: claude.fn });
  assert.equal(claude.calls, 0);
  assert.equal(out.needsCloserLook, true);
  assert.equal(out.value, "x", "free keeps the deterministic value");

  const budget2 = new ScanBudget({ tier: "free" });
  const out2 = await decide({ fallback: "x", tier: "free", budget: budget2, jev: async () => j("lead", 0.5), claude: async () => j("booking", 0.95, "claude") });
  assert.equal(out2.tier, "claude");
  assert.equal(out2.value, "booking");
});

test("failing steps are skipped, never thrown", async () => {
  const out = await decide<string>({
    fallback: "x",
    tier: "free",
    rules: () => {
      throw new Error("rules bug");
    },
    jev: async () => {
      throw new Error("network");
    },
    claude: async () => ({ ...j("y", 1, "claude"), degraded: "timeout" }),
  });
  assert.equal(out.needsCloserLook, true);
  assert.equal(out.value, "x");
});
