/**
 * Live smoke test (NOT part of npm test). Needs real keys in the environment:
 *   cd /home/user/strativra-engine && set -a && . ./.env && set +a && \
 *   NODE_USE_ENV_PROXY=1 node --experimental-strip-types src/ai/smoke.ts
 * One Claude narrate on the fictional sample report (claude-haiku-5-5, max_tokens 1500)
 * and one Jev batch. Prints latency, usage and lock results. Never prints keys.
 */
import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient, choice, score } from "@typesafe-ai/sdk";
import { sampleReport } from "../report/fixtures/sample-report.ts";
import { ScanBudget } from "./budget.ts";
import { AiJudge, IMPACT_RUBRIC, SEVERITY_QUESTIONS, jevState, supportsQuestion } from "./judge.ts";
import { buildEvidenceIndex, pick } from "./redact.ts";
import { sampleCapture } from "./fakes.test-util.ts";
import { AiWriter } from "./writer.ts";
import { claimErrors } from "./validate.ts";

const built = buildEvidenceIndex({ report: sampleReport, capture: sampleCapture(), tier: "free" });

async function claudeSmoke() {
  if (!process.env.ANTHROPIC_API_KEY) return console.log("claude: skipped (no ANTHROPIC_API_KEY)");
  const budget = new ScanBudget({ tier: "free" });
  const writer = new AiWriter(new Anthropic(), { budget, maxTokens: { narrate: 1500 } });
  const t0 = performance.now();
  const n = await writer.narrate(sampleReport, "free", built);
  const ms = Math.round(performance.now() - t0);
  console.log(`claude: ${ms} ms, calls ${budget.usage.claudeCalls}, usage`, {
    input: budget.usage.claudeInputTokens,
    output: budget.usage.claudeOutputTokens,
    cacheRead: budget.usage.claudeCacheReadTokens,
    cacheWrite: budget.usage.claudeCacheWriteTokens,
    usd: Number(budget.usage.usd.toFixed(6)),
    degraded: budget.usage.degraded,
  });
  console.log("lock:", JSON.stringify(writer.lastLock), "lastError:", writer.lastError ?? "none");
  for (const c of n.summary) console.log(`  summary [${c.source}] ${c.text} ${JSON.stringify(c.evidenceIds)}`);
  for (const [id, f] of Object.entries(n.findings)) {
    console.log(`  ${id}.why [${f.why.source}] ${f.why.text} ${JSON.stringify(f.why.evidenceIds)}`);
    console.log(`  ${id}.fix [${f.fix.source}] ${f.fix.text} ${JSON.stringify(f.fix.evidenceIds)}`);
  }
  const ai = [...n.summary, ...Object.values(n.findings).flatMap((f) => [f.why, f.fix])].filter((c) => c.source === "ai");
  console.log(`claude: ${ai.length} AI claims, re-validated errors: ${ai.reduce((s, c) => s + claimErrors(c, built.index).length, 0)}`);
}

async function jevSmoke() {
  if (!process.env.TYPESAFE_API_KEY) return console.log("jev: skipped (no TYPESAFE_API_KEY)");
  const budget = new ScanBudget({ tier: "free" });
  const judge = new AiJudge(new TypeSafeClient(), { budget });
  const items = pick(built.index, ["r", "cp:cp2", "h1", "f:consent.fires_before_consent"]);
  const t0 = performance.now();
  const r = await judge.batch({
    state: jevState("Evidence from a website tracking audit scan.", items),
    questions: {
      form_type: choice({ question: "Which conversion type is this conversion point?", item: "cp:cp2" }, {
        purchase: null, lead: "Sends an enquiry through a form.", booking: null, signup: null, contact_click: null, download: null,
      }),
      supports: supportsQuestion("A GA4 page_view hit was sent before any consent banner click.", ["h1"]),
      severity_compliance: score({ finding: "f:consent.fires_before_consent", question: SEVERITY_QUESTIONS.compliance }, [...IMPACT_RUBRIC]),
    },
  });
  const ms = Math.round(performance.now() - t0);
  console.log(`jev: ${ms} ms`, r.ok ? { model: r.model, answers: r.answers } : r, "usage", { input: budget.usage.jevInputTokens, output: budget.usage.jevOutputTokens });
}

await claudeSmoke().catch((e) => console.log("claude: failed", e instanceof Error ? e.name + ": " + e.message : e));
await jevSmoke().catch((e) => console.log("jev: failed", e instanceof Error ? e.name + ": " + e.message : e));
