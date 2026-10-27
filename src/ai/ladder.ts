/**
 * Escalation ladder for any judgment:
 *   rules -> Jev (accept at confidence >= threshold) -> Claude (paid always,
 *   free only within budget) -> owner review (paid) / "Needs a closer look" (free).
 * Never throws: a step that fails is skipped.
 */
import type { ScanBudget } from "./budget.ts";
import type { Judgment, Tier } from "./types.ts";

export interface LadderSteps<T> {
  /** Deterministic default when nothing is confident (usually the rules' own value). */
  fallback: T;
  rules?: () => Judgment<T> | undefined;
  jev?: () => Promise<Judgment<T>>;
  claude?: () => Promise<Judgment<T>>;
  /** Default 0.8. Applied to every step. Config, until Jev is calibrated on a labelled set. */
  threshold?: number;
  tier: Tier;
  /** Free tier: Claude only runs when this says yes. */
  budget?: ScanBudget;
  /** Rough Claude tokens for this step, for the free budget check. */
  claudeTokens?: number;
}

async function safe<T>(fn: () => Promise<Judgment<T>> | Judgment<T> | undefined): Promise<Judgment<T> | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

export async function decide<T>(steps: LadderSteps<T>): Promise<Judgment<T>> {
  const threshold = steps.threshold ?? 0.8;
  const ok = (j: Judgment<T> | undefined): boolean => !!j && !j.degraded && j.confidence >= threshold;
  const tried: Judgment<T>[] = [];

  if (steps.rules) {
    const r = await safe(steps.rules);
    if (r && ok(r)) return { ...r, tier: "rules" };
    if (r) tried.push(r);
  }

  if (steps.jev) {
    const j = await safe(steps.jev);
    if (j && ok(j)) return { ...j, tier: "jev" };
    if (j && !j.degraded) tried.push(j);
  }

  if (steps.claude) {
    const allowed = steps.tier === "paid" || !steps.budget || steps.budget.allowClaude(steps.claudeTokens ?? 2000);
    if (allowed) {
      const c = await safe(steps.claude);
      if (c && ok(c)) return { ...c, tier: "claude" };
      if (c && !c.degraded) tried.push(c);
    }
  }

  const best = tried.sort((a, b) => b.confidence - a.confidence)[0];
  const evidenceIds = [...new Set(tried.flatMap((t) => t.evidenceIds))];
  if (steps.tier === "paid") {
    // Owner review queue. Keep the best guess for the reviewer.
    return { value: best?.value ?? steps.fallback, confidence: best?.confidence ?? 0, tier: "review", evidenceIds };
  }
  // Free: keep the deterministic value, flag it.
  return { value: steps.fallback, confidence: best?.confidence ?? 0, tier: best?.tier ?? "rules", evidenceIds, needsCloserLook: true };
}
