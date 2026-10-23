import { note } from "./helpers.ts";
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
  return { findings: guardFailedTags(ctx, findings), errors };
}

/** Findings that only say "we saw nothing": unknowable when the tag libraries themselves never loaded. */
const ABSENCE_RULES = new Set([
  "install.no_ga4",
  "install.spa_missing_page_view",
  "conversion.funnel_step_untracked",
  "conversion.form_start_missing",
  "conversion.final_event_unverified",
]);

const TAG_LIBRARY = /^https:\/\/(www\.googletagmanager\.com\/(gtm\.js|gtag\/js)|connect\.facebook\.net\/|snap\.licdn\.com\/|analytics\.tiktok\.com\/|bat\.bing\.com\/bat\.js)/;

/**
 * A tag manager or pixel library that failed to load (network error, blocked egress, ad blocker,
 * outage) makes every "not tracked" finding a guess. Drop those and say what happened instead.
 */
export function guardFailedTags(ctx: RuleContext, findings: Finding[]): Finding[] {
  const failed = ctx.capture.scenarios.flatMap((s) => s.requests).filter((r) => r.failed && TAG_LIBRARY.test(r.url));
  if (!failed.length) return findings;
  const kept = findings.filter((f) => !ABSENCE_RULES.has(f.id));
  const libs = [...new Set(failed.map((r) => r.url.split("?")[0]))];
  kept.push({
    id: "scan.tag_library_failed",
    title: "Your tags did not load during our scan",
    severity: "medium",
    why: "Your tag manager or pixel script failed to load, so we could not test what it sends. It can be our network, an outage, or a broken container. A visitor with the same problem sends you no data.",
    conversionTypes: [],
    vendors: ["gtm"],
    impact: 3,
    confidence: 1,
    reach: 3,
    effort: 1,
    reproduced: false,
    evidence: [note(`Scripts that failed to load: ${libs.join(", ")}`, failed.slice(0, 5).map((r) => ({ scenario: r.scenario, phase: r.phase, url: r.url.slice(0, 160), error: r.failed })))],
    fix: {
      summary: "Check that your container loads for every visitor, then scan again.",
      steps: [
        "Open your site in a private window and check in the browser console that the script loads.",
        "If it loads for you, scan again. If it fails, check the container ID and any script blocking on your server or CDN.",
      ],
    },
  });
  return kept;
}
