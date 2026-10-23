import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { sampleReport } from "../report/fixtures/sample-report.ts";
import { ScanBudget } from "./budget.ts";
import { buildEvidenceIndex } from "./redact.ts";
import { FakeClaude, sampleCapture } from "./fakes.test-util.ts";
import { AiWriter, type ClaudeClient, MAX_TOKENS } from "./writer.ts";

const freeBuilt = () => buildEvidenceIndex({ report: sampleReport, capture: sampleCapture(), tier: "free" });

test("a real Anthropic client satisfies ClaudeClient (type check)", () => {
  const c: ClaudeClient = new Anthropic({ apiKey: "test-key" });
  assert.ok(c);
});

test("narrate: structured output, cached static system, tier model and caps, redacted evidence", async () => {
  const claude = new FakeClaude(() => ({
    summary: [{ text: "Ads and analytics tags fire before any banner click.", evidenceIds: ["f:consent.fires_before_consent", "h1"] }],
    findings: [
      { id: "f:consent.fires_before_consent", why: { text: "A page_view hit was sent before consent.", evidenceIds: ["h1"] }, fix: { text: "Set consent defaults to denied.", evidenceIds: ["f:consent.fires_before_consent"] } },
      { id: "purchase.missing_transaction_id", why: { text: "Each reload can count the order twice — bad.", evidenceIds: ["f:purchase.missing_transaction_id"] }, fix: { text: "Push the order id as transaction_id.", evidenceIds: ["f:purchase.missing_transaction_id"] } },
    ],
  }));
  const writer = new AiWriter(claude, { budget: new ScanBudget({ tier: "free" }) });
  const n = await writer.narrate(sampleReport, "free", freeBuilt());

  const p = claude.calls[0];
  assert.equal(p.model, "claude-haiku-5-5");
  assert.equal(p.max_tokens, MAX_TOKENS.free.narrate);
  assert.equal(p.output_config?.format?.type, "json_schema");
  assert.equal(p.output_config?.effort, "low");
  const sys = p.system as Anthropic.TextBlockParam[];
  assert.deepEqual(sys[sys.length - 1].cache_control, { type: "ephemeral" });
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(sys)), "no dates in the cached prefix");
  const sent = claude.sent();
  for (const bad of ["jane", "1234567890.1700000000", "abc123", "Turn on enhanced conversions"]) assert.ok(!sent.includes(bad), bad);

  assert.equal(n.summary[0].source, "ai");
  assert.equal(n.findings["consent.fires_before_consent"].why.source, "ai");
  // the dash claim fails, gets one repair round (same bad answer) and falls back to the rules text
  assert.equal(claude.calls.length, 2);
  assert.equal(n.findings["purchase.missing_transaction_id"].why.source, "template");
  assert.equal(n.findings["purchase.missing_transaction_id"].why.text, sampleReport.findings[1].why);
  assert.equal(n.findings["purchase.missing_transaction_id"].fix.source, "ai");
  // repair turn is append-only: user, assistant, user
  assert.deepEqual(claude.calls[1].messages.map((m) => m.role), ["user", "assistant", "user"]);
  // locked findings are not narrated on free
  assert.equal(n.findings["gads.no_enhanced_conversions"], undefined);
});

test("paid uses Opus with bigger caps", async () => {
  const claude = new FakeClaude(() => ({ summary: [], findings: [] }));
  await new AiWriter(claude).narrate({ ...sampleReport, kind: "paid" }, "paid", buildEvidenceIndex({ report: sampleReport, capture: sampleCapture(), tier: "paid" }));
  assert.equal(claude.calls[0].model, "claude-opus-5-5");
  assert.equal(claude.calls[0].max_tokens, MAX_TOKENS.paid.narrate);
});

test("narrate degrades to templates on refusal, errors or no client", async () => {
  for (const claude of [new FakeClaude(() => ({}), { stop: "refusal" }), new FakeClaude(() => ({}), { throws: new Error("down") }), undefined]) {
    const n = await new AiWriter(claude).narrate(sampleReport, "free", freeBuilt());
    assert.ok(n.summary.every((c) => c.source === "template"));
    assert.ok(Object.values(n.findings).every((f) => f.why.source === "template" && f.fix.source === "template"));
  }
});

test("ask on a locked finding (free): covered in the full audit, no leak", async () => {
  const claude = new FakeClaude(() => ({
    answer: { text: "Your Google Ads label abc123 lacks user data; turn on enhanced conversions.", evidenceIds: ["f:gads.no_enhanced_conversions"] },
    aboutLockedFinding: "f:gads.no_enhanced_conversions",
  }));
  const writer = new AiWriter(claude);
  const a = await writer.ask("What is wrong with my Google Ads conversions? my email is jane.doe@example.org", sampleReport, "free", freeBuilt());
  assert.match(a.text, /covered in the full audit/);
  assert.match(a.text, /Book the Tracking Audit/);
  assert.ok(!a.text.includes("abc123") && !/enhanced conversions with hashed/i.test(a.text));
  // only the first request is ours; a repair turn echoes the model's own previous answer
  const sent = JSON.stringify(claude.calls[0]);
  assert.ok(!sent.includes("abc123"), "locked evidence never sent");
  assert.ok(!sent.includes(sampleReport.findings[4].fix.summary), "locked fix never sent");
  assert.ok(!sent.includes("jane.doe"), "question is redacted");
});

test("ask naming a locked finding title short-circuits without a model call", async () => {
  const claude = new FakeClaude(() => ({}));
  const a = await new AiWriter(claude).ask("Tell me about: Google Ads conversion sent without enhanced conversions", sampleReport, "free", freeBuilt());
  assert.equal(claude.calls.length, 0);
  assert.equal(a.source, "template");
  assert.deepEqual(a.evidenceIds, ["f:gads.no_enhanced_conversions"]);
});

test("ask on an open finding returns the locked (validated) AI answer", async () => {
  const claude = new FakeClaude(() => ({ answer: { text: "The purchase push has no transaction_id, so reloads can double count.", evidenceIds: ["f:purchase.missing_transaction_id"] }, aboutLockedFinding: null }));
  const a = await new AiWriter(claude).ask("Why is purchase broken?", sampleReport, "free", freeBuilt());
  assert.equal(a.source, "ai");
});

test("reason: picks an option with confidence, invalid answers degrade", async () => {
  const built = freeBuilt();
  const ev = [built.index.get("cp:cp2")!];
  const ok = await new AiWriter(new FakeClaude(() => ({ answer: "yes", confidence: 0.9, evidenceIds: ["cp:cp2"], rationale: "A contact form." }))).reason({ text: "Real?", options: ["yes", "no"], fallback: "yes" }, ev, "paid");
  assert.deepEqual([ok.value, ok.confidence, ok.tier], ["yes", 0.9, "claude"]);
  const bad = await new AiWriter(new FakeClaude(() => ({ answer: "maybe", confidence: 1, evidenceIds: ["zz"], rationale: "" }))).reason({ text: "Real?", options: ["yes", "no"], fallback: "no" }, ev, "paid");
  assert.deepEqual([bad.value, bad.degraded], ["no", "invalid"]);
});
