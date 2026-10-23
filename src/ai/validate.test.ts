import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleReport } from "../report/fixtures/sample-report.ts";
import { AiJudge } from "./judge.ts";
import { buildEvidenceIndex } from "./redact.ts";
import { FakeJev, sampleCapture } from "./fakes.test-util.ts";
import { claimErrors, lockedGenerate } from "./validate.ts";

const { index } = buildEvidenceIndex({ report: sampleReport, capture: sampleCapture(), tier: "paid" });
const codes = (text: string, ids: string[]) => claimErrors({ text, evidenceIds: ids }, index).map((e) => e.code);

test("valid cited claim passes", () => {
  assert.deepEqual(codes("A page_view hit was sent to www.google-analytics.com before any banner click.", ["h1"]), []);
  assert.deepEqual(codes("The purchase push has no transaction_id.", ["f:purchase.missing_transaction_id"]), []);
});

test("rejects missing and unknown ids", () => {
  assert.deepEqual(codes("Tags fire early.", []), ["no_citation"]);
  assert.ok(codes("Tags fire early.", ["h999"]).includes("unknown_id"));
});

test("rejects uncited event names, domains and numbers", () => {
  assert.ok(codes("The generate_lead event is missing.", ["h1"]).includes("uncited_event"));
  assert.ok(codes("Meta Purchase fired.", ["h1"]).includes("uncited_event"));
  assert.ok(codes("Hits go to analytics.tiktok.com.", ["h1"]).includes("uncited_domain"));
  assert.ok(codes("You lose 37% of conversions.", ["h1"]).includes("uncited_number"));
  // the number exists in other evidence, but not in the cited item
  assert.ok(codes("Two page_view hits within 38 ms.", ["h1"]).includes("uncited_number"));
  assert.deepEqual(codes("Two page_view hits within 38 ms.", ["f:gtm.duplicate_ga4_config"]), []);
});

test("rejects dashes and prices", () => {
  assert.ok(codes("Tags fire early — before consent.", ["h1"]).includes("dash"));
  assert.ok(codes("Tags fire early – before consent.", ["h1"]).includes("dash"));
  assert.ok(codes("The audit costs €900.", ["h1"]).includes("price"));
  assert.ok(codes("Worth 49.9 EUR per order.", ["d2"]).includes("price"));
});

const fallback = { a: { text: "Template A.", evidenceIds: ["r"] }, b: { text: "Template B.", evidenceIds: ["f:consent.fires_before_consent"] } };

test("lockedGenerate: repair round fixes a bad claim", async () => {
  const seen: unknown[] = [];
  const res = await lockedGenerate(
    async (repair) => {
      seen.push(repair);
      return repair
        ? { a: { text: "A page_view hit fired before consent.", evidenceIds: ["h1"] } }
        : { a: { text: "You lose 40% of data.", evidenceIds: ["h1"] }, b: { text: "Consent is ignored.", evidenceIds: ["f:consent.fires_before_consent"] } };
    },
    index,
    fallback,
  );
  assert.equal(res.repaired, true);
  assert.equal(res.claims.a.source, "ai");
  assert.equal(res.claims.b.source, "ai");
  assert.equal(seen.length, 2);
  assert.ok((seen[1] as Record<string, unknown>).a, "repair got the errors for a");
  assert.equal((seen[1] as Record<string, unknown>).b, undefined, "b already passed");
});

test("lockedGenerate: still bad after repair -> deterministic template", async () => {
  let n = 0;
  const res = await lockedGenerate(async () => (n++, { a: { text: "Uncited 99 thing — bad.", evidenceIds: ["zz"] }, b: { text: "Fine claim.", evidenceIds: ["r"] } }), index, fallback);
  assert.equal(n, 2);
  assert.deepEqual(res.claims.a, { text: "Template A.", evidenceIds: ["r"], source: "template" });
  assert.equal(res.claims.b.source, "ai");
  assert.ok(res.rejected.a!.some((e) => e.code === "unknown_id"));
});

test("lockedGenerate: generator failure -> all templates, never throws", async () => {
  const res = await lockedGenerate(async () => {
    throw new Error("boom");
  }, index, fallback);
  assert.equal(res.claims.a.source, "template");
  assert.equal(res.claims.b.source, "template");
});

test("gate 2: Jev contradicts or low-confidence supports -> template", async () => {
  const jev = new FakeJev({
    answer: (name) =>
      name === "c0"
        ? { type: "choice", choice: "contradicts", confidence: 0.9, probabilities: { supports: 0.05, contradicts: 0.9, unrelated: 0.05 } }
        : { type: "choice", choice: "supports", confidence: 0.6, probabilities: { supports: 0.6, contradicts: 0.2, unrelated: 0.2 } },
  });
  const judge = new AiJudge(jev);
  const res = await lockedGenerate(async () => ({ a: { text: "Fine claim.", evidenceIds: ["r"] }, b: { text: "Other claim.", evidenceIds: ["h1"] } }), index, fallback, { judge });
  assert.equal(jev.calls.length, 1, "one batched gate request");
  assert.equal(res.claims.a.source, "template");
  assert.equal(res.claims.b.source, "template");
  assert.equal(res.rejected.a![0].code, "not_supported");
});

test("gate 2: high-confidence supports passes", async () => {
  const judge = new AiJudge(new FakeJev({ confidence: 0.95 }));
  const res = await lockedGenerate(async () => ({ a: { text: "Fine claim.", evidenceIds: ["r"] }, b: { text: "Other claim.", evidenceIds: ["h1"] } }), index, fallback, { judge });
  assert.equal(res.claims.a.source, "ai");
  assert.equal(res.claims.b.source, "ai");
});
