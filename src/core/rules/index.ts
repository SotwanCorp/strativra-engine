import type { Finding } from "../../types.ts";
import { ATTRIBUTION_RULES } from "./attribution.ts";
import { CONSENT_RULES } from "./consent.ts";
import { CONVERSION_RULES } from "./conversions.ts";
import { INSTALLATION_RULES } from "./installation.ts";
import type { Rule, RuleContext } from "./types.ts";

export type { Rule, RuleContext } from "./types.ts";

/** Every v1 rule (outside-in, free tier), in catalogue order. */
export const RULES: Rule[] = [...CONSENT_RULES, ...INSTALLATION_RULES, ...CONVERSION_RULES, ...ATTRIBUTION_RULES];

/**
 * Run rules against one capture. An aborted capture yields no findings (the
 * report shows the abort instead). A rule that throws is skipped, never
 * fatal; its error is returned so the caller can log it.
 * Findings are unique by id: a later finding with an existing id is dropped.
 */
export function runRules(ctx: RuleContext, rules: Rule[] = RULES): { findings: Finding[]; errors: Array<{ rule: string; error: string }> } {
  const findings: Finding[] = [];
  const errors: Array<{ rule: string; error: string }> = [];
  if (ctx.capture.aborted) return { findings, errors };
  const seen = new Set<string>();
  for (const rule of rules) {
    try {
      if (rule.appliesTo && !rule.appliesTo(ctx)) continue;
      for (const f of rule.run(ctx)) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        findings.push(f);
      }
    } catch (e) {
      errors.push({ rule: rule.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { findings, errors };
}
