/**
 * Report model: Capture + DecodedHit[] -> Report.
 * Pure. The renderer (src/report/) turns this into HTML/PDF and calls
 * redactForFree() before rendering a free report.
 */
import type {
  BannerOutcome,
  Capture,
  ContractStatus,
  ConversionStatus,
  ConversionType,
  DecodedHit,
  Finding,
  Report,
  ReportKind,
  Scenario,
  Severity,
  StackItem,
  Vendor,
} from "../types.ts";
import { rank } from "./rank.ts";
import { RULES, runRules } from "./rules/index.ts";
import type { Rule } from "./rules/index.ts";
import { VENDOR_NAMES, hostOf, isTracking, uniq } from "./rules/helpers.ts";

const STACK_ORDER: Vendor[] = ["gtm", "sgtm", "ga4", "google_ads", "floodlight", "meta", "linkedin", "tiktok", "ms_uet", "other"];
const CONVERSION_ORDER: ConversionType[] = ["purchase", "lead", "booking", "signup", "contact_click", "download"];
const TYPE_LABEL: Record<ConversionType, string> = {
  purchase: "Purchases",
  lead: "Leads",
  booking: "Bookings",
  signup: "Sign-ups",
  contact_click: "Contact clicks",
  download: "Downloads",
};
/** Types whose last step we can safely do ourselves (a click), or walk up to. */
const WALKABLE: ConversionType[] = ["purchase", "contact_click", "download"];

export function buildStack(capture: Capture, hits: DecodedHit[]): StackItem[] {
  const out: StackItem[] = [];
  for (const v of STACK_ORDER) {
    const vh = hits.filter((h) => h.vendor === v);
    if (vh.length === 0) continue;
    const item: StackItem = {
      vendor: v,
      name: VENDOR_NAMES[v],
      ids: uniq(vh.map((h) => h.accountId).filter((x): x is string => !!x)).sort(),
      source: "network",
    };
    if (vh.some((h) => h.firstParty)) item.firstParty = true;
    out.push(item);
  }
  for (const cmp of uniq(capture.scenarios.map((s) => s.cmp).filter((x): x is string => !!x))) {
    out.push({ vendor: "cmp", name: cmp, ids: [], source: "global" });
  }
  for (const p of uniq(capture.platformHints)) out.push({ vendor: "platform", name: p, ids: [], source: "html" });
  return out;
}

const SEV: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function conversionStatuses(capture: Capture, hits: DecodedHit[], findings: Finding[]): ConversionStatus[] {
  const types = CONVERSION_ORDER.filter((t) => capture.conversionPoints.some((p) => p.type === t));
  const anyTracking = hits.some(isTracking);
  return types.map((type) => {
    const points = capture.conversionPoints.filter((p) => p.type === type);
    const ids = points.map((p) => p.id);
    const label = TYPE_LABEL[type];
    const mk = (status: ContractStatus, summary: string): ConversionStatus => ({ type, points: ids, status, summary });

    if (capture.aborted) return mk("not_testable", `${label}: the scan could not run, so this was not tested.`);
    if (!anyTracking) return mk("not_tracked", `${label}: no tracking tag sent any data.`);

    const related = findings.filter((f) => f.conversionTypes.includes(type)).sort((a, b) => SEV[a.severity] - SEV[b.severity]);
    const proven = related.filter((f) => f.reproduced);
    const worst = proven[0];
    if (worst && (worst.severity === "critical" || worst.severity === "high")) {
      return mk("broken", `${label}: ${worst.title.toLowerCase()}.`);
    }
    if (worst) return mk("partial", `${label}: ${worst.title.toLowerCase()}.`);
    if (related.length > 0) return mk("partial", `${label}: ${related[0].title.toLowerCase()} (not confirmed from outside).`);

    const walked = points.some((p) => p.walk.some((s) => s.ok));
    if (WALKABLE.includes(type) && !walked) return mk("not_testable", `${label}: we could not walk this path safely.`);
    if (!WALKABLE.includes(type)) return mk("ok", `${label}: the steps we can see look right. The final submit is checked in the paid audit.`);
    return mk("ok", `${label}: every step we walked was tracked.`);
  });
}

export interface BuildOptions {
  now?: Date;
  rules?: Rule[];
}

export function buildReport(capture: Capture, hits: DecodedHit[], kind: ReportKind, id: string, opts: BuildOptions = {}): Report {
  const siteHost = hostOf(capture.finalUrl || capture.target);
  const { findings: raw } = runRules({ capture, hits, siteHost }, opts.rules ?? RULES);
  const ranked = rank(raw);
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of ranked.findings) counts[f.severity]++;
  const banner: Partial<Record<Scenario, BannerOutcome>> = {};
  for (const s of capture.scenarios) banner[s.scenario] = s.banner;
  const scan: Report["scan"] = { pages: capture.pages.length, durationMs: capture.durationMs, banner };
  if (capture.aborted) scan.aborted = capture.aborted;
  return {
    id,
    kind,
    target: capture.target,
    finalUrl: capture.finalUrl,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    region: capture.region,
    stack: buildStack(capture, hits),
    conversions: conversionStatuses(capture, hits, ranked.findings),
    findings: ranked.findings,
    open: kind === "free" ? ranked.top : ranked.findings.map((f) => f.id),
    counts,
    rankNotes: ranked.notes,
    scan,
  };
}

/**
 * Free report: locked findings keep their real title, severity and why.
 * Evidence and fix are removed so they never reach the browser.
 */
export function redactForFree(report: Report): Report {
  if (report.kind !== "free") return report;
  const open = new Set(report.open);
  return {
    ...report,
    findings: report.findings.map((f) => (open.has(f.id) ? f : { ...f, evidence: [], fix: { summary: "", steps: [] } })),
  };
}
