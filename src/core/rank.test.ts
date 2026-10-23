import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "../types.ts";
import { rank, score } from "./rank.ts";
import { runRules } from "./rules/index.ts";
import { leadSite, shopSite, tagsBeforeConsent } from "./rules/fixtures.ts";

function f(id: string, p: Partial<Finding>): Finding {
  return {
    id,
    title: id,
    severity: "medium",
    why: "x",
    conversionTypes: [],
    vendors: [],
    impact: 3,
    confidence: 2,
    reach: 2,
    effort: 2,
    reproduced: true,
    evidence: [],
    fix: { summary: "", steps: [] },
    ...p,
  };
}

test("score and tie-breaks: score, then lower effort, then severity", () => {
  const r = rank([
    f("a", { impact: 2 }),
    f("b", { effort: 3 }),
    f("c", { effort: 1 }),
    f("d", { effort: 3, severity: "high" }),
    f("e", { impact: 5, confidence: 3, reach: 3, reproduced: false }),
  ]);
  assert.equal(score(r.findings[0]), 45);
  assert.deepEqual(r.findings.map((x) => x.id), ["e", "c", "d", "b", "a"]);
  assert.deepEqual(r.top, ["c", "d", "b"], "unreproduced e never enters top 3");
  assert.deepEqual(Object.keys(r.notes).sort(), ["b", "c", "d"]);
  assert.match(r.notes.c, /^#1: score 12 of 45/);
});

test("fixture rankings and top 3", () => {
  const shop = shopSite();
  const rs = rank(runRules({ capture: shop.capture, hits: shop.hits, siteHost: "shop.example" }).findings);
  assert.deepEqual(rs.top, ["conversion.ecommerce_params_missing", "conversion.funnel_step_untracked", "conversion.meta_no_event_id"]);

  const early = tagsBeforeConsent();
  const re = rank(runRules({ capture: early.capture, hits: early.hits, siteHost: "early.example" }).findings);
  assert.equal(re.top[0], "consent.fires_before_consent");

  const lead = leadSite();
  const rl = rank(runRules({ capture: lead.capture, hits: lead.hits, siteHost: "lead.example" }).findings);
  assert.deepEqual(rl.top, ["conversion.form_start_missing"]);
  assert.ok(rl.findings.some((x) => x.id === "conversion.final_event_unverified"));
});
