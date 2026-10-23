/**
 * enrichReport: the AI layer on top of a finished deterministic report.
 *
 * 1. Build the redacted evidence index.
 * 2. One Jev batch for the ambiguous items: business model; per ambiguous
 *    conversion point "is it real" (2-option choice) + its type (choice);
 *    per finding four atomic severity scores, combined in code, max one level move.
 * 3. Escalate unresolved conversion points through the ladder (Claude reason).
 * 4. Narrate with Claude under the evidence lock (template text otherwise).
 * 5. Infer the tracking plan (deterministic base, AI draft on top, statuses in code).
 *
 * With no deps (or once a budget trips) the output is the deterministic report
 * unchanged, plus the deterministic plan. Never throws on AI failures.
 */
import { choice } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { Capture, ConversionPoint, ConversionType, DecodedHit, Report, Severity } from "../types.ts";
import { type DailyBreaker, ScanBudget, type UsageLog } from "./budget.ts";
import {
  AiJudge,
  type JevClient,
  fromChoice,
  jevState,
  pickAxes,
  severityFromAnswers,
  severityQuestions,
  yesNoFromChoice,
} from "./judge.ts";
import { decide } from "./ladder.ts";
import { type BuiltIndex, buildEvidenceIndex, findingEvidenceIds, pick } from "./redact.ts";
import type { BusinessModel, EvidenceItem, Judgment, Narrative, PlanEvent, PlanEventStatus, PlanStatus, Tier, TrackingPlan } from "./types.ts";
import { AiWriter, BUSINESS_MODELS, CONVERSION_TYPES, type ClaudeClient, type SiteSummary, planWhyTemplate } from "./writer.ts";

export interface EnrichDeps {
  jev?: JevClient;
  claude?: ClaudeClient;
  budget?: ScanBudget;
  breaker?: DailyBreaker;
  /** Accept threshold for Jev and Claude confidence. Default 0.8 (to calibrate). */
  threshold?: number;
  /** Decoded hits, when the decoder ran (better evidence than raw requests). */
  hits?: DecodedHit[];
  /** Evidence-lock gate 2 (Jev supports check). Default on when Jev is present. */
  supportsGate?: boolean;
  /** Max findings sent to Jev for severity. */
  maxSeverityFindings?: number;
}

export interface EnrichResult {
  report: Report;
  plan: TrackingPlan;
  usage: UsageLog;
  narrative?: Narrative;
  judgments: {
    businessModel?: Judgment<BusinessModel>;
    conversionPoints: Record<string, { real: Judgment<boolean>; type?: Judgment<ConversionType> }>;
    severity: Record<string, Judgment<Severity>>;
  };
  /** Free: conversion point ids shown as "Needs a closer look". Paid: owner review queue. */
  needsCloserLook: string[];
  review: string[];
}

const BM_LABELS: Record<BusinessModel, string> = {
  ecommerce: "Sells products online with a cart and checkout.",
  lead_gen: "Gets enquiries through forms, calls or emails.",
  saas: "Software product with sign ups or trials.",
  booking: "Takes appointments, reservations or bookings.",
  content: "Publishes content, monetised by ads or subscriptions.",
  local_service: "A local business: visits, calls and directions matter most.",
  other: "None of these.",
};

const CT_LABELS: Record<ConversionType, string> = {
  purchase: "Completes an order and payment.",
  lead: "Sends an enquiry or quote request through a form.",
  booking: "Books an appointment, table or slot.",
  signup: "Creates an account or starts a trial or newsletter subscription.",
  contact_click: "Clicks a phone, email or messaging link.",
  download: "Downloads a file such as a brochure or price list.",
};

export async function enrichReport(report: Report, capture: Capture | undefined, deps: EnrichDeps = {}, tier: Tier = report.kind): Promise<EnrichResult> {
  const threshold = deps.threshold ?? 0.8;
  const budget = deps.budget ?? new ScanBudget({ tier, breaker: deps.breaker });
  const built = buildEvidenceIndex({ report, capture, hits: deps.hits, tier });
  const judge = deps.jev ? new AiJudge(deps.jev, { budget, threshold }) : undefined;
  const writer = deps.claude ? new AiWriter(deps.claude, { budget, judge: deps.supportsGate === false ? undefined : judge }) : undefined;

  const base = basePlan(report, capture, built);
  const out: EnrichResult = {
    report: { ...report, plan: base },
    plan: base,
    usage: budget.usage,
    judgments: { conversionPoints: {}, severity: {} },
    needsCloserLook: [],
    review: [],
  };
  if (!judge && !writer) return out;

  const next: Report = structuredClone(report);

  /* ---------- 1. one Jev batch ---------- */
  const cps = (capture?.conversionPoints ?? []).filter((cp) => cp.confidence < threshold);
  const openSet = new Set(tier === "paid" ? report.findings.map((f) => f.id) : report.open);
  const sevFindings = report.findings.filter((f) => openSet.has(f.id)).slice(0, deps.maxSeverityFindings ?? 12);

  let answers: Record<string, unknown> | undefined;
  if (judge) {
    const questions: Questions = {
      bm: choice("Which business model does this website have, judging by its pages, tags and conversion points?", BM_LABELS),
    };
    cps.forEach((cp, i) => {
      questions[`cp${i}_real`] = choice(
        { question: "Is this a real conversion point where a visitor becomes a customer or lead (not a login, search or newsletter box mislabelled)?", item: `cp:${cp.id}` },
        { yes: null, no: null },
      );
      questions[`cp${i}_type`] = choice({ question: "Which conversion type is this conversion point?", item: `cp:${cp.id}` }, CT_LABELS);
    });
    sevFindings.forEach((f, i) => Object.assign(questions, severityQuestions(`f${i}`, `f:${f.id} ${f.title}`)));

    const ids = new Set<string>(["r"]);
    for (const k of built.index.keys()) if (/^(t|p)\d+$/.test(k)) ids.add(k);
    for (const cp of cps) ids.add(`cp:${cp.id}`);
    for (const f of sevFindings) for (const id of findingEvidenceIds(f, built.refToId)) ids.add(id);
    const r = await judge.batch({ state: jevState("Evidence from a website tracking audit scan.", pick(built.index, ids)), questions });
    if (r.ok) answers = r.answers;
  }
  const A = (k: string) => answers?.[k] as Parameters<typeof fromChoice>[0];

  /* ---------- business model ---------- */
  if (answers) {
    const bm = fromChoice(A("bm"), BUSINESS_MODELS, ["r"]);
    if (bm) out.judgments.businessModel = bm;
  }

  /* ---------- conversion points via the ladder ---------- */
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const ev = pick(built.index, [`cp:${cp.id}`, "r"]);
    const real = await decide<boolean>({
      fallback: true,
      tier,
      threshold,
      budget,
      rules: () => ({ value: true, confidence: cp.confidence, tier: "rules", evidenceIds: [`cp:${cp.id}`] }),
      jev: answers ? async () => yesNoFromChoice(A(`cp${i}_real`), [`cp:${cp.id}`]) ?? degraded(true) : undefined,
      claude: writer
        ? async () => {
            const j = await writer.reason({ text: `Is conversion point cp:${cp.id} a real conversion point?`, options: ["yes", "no"], fallback: "yes" }, ev, tier);
            return { ...j, value: j.value === "yes" };
          }
        : undefined,
    });
    const typeJ = answers ? fromChoice(A(`cp${i}_type`), CONVERSION_TYPES, [`cp:${cp.id}`]) : undefined;
    out.judgments.conversionPoints[cp.id] = { real, ...(typeJ ? { type: typeJ } : {}) };
    if (real.needsCloserLook) out.needsCloserLook.push(cp.id);
    if (real.tier === "review") out.review.push(cp.id);
  }

  /* ---------- severity: composite, at most one level, only when confident ---------- */
  if (answers) {
    sevFindings.forEach((f, i) => {
      const j = severityFromAnswers(f.severity, pickAxes(answers as never, `f${i}`), findingEvidenceIds(f, built.refToId));
      if (!j) return;
      out.judgments.severity[f.id] = j;
      if (j.confidence >= threshold && j.value !== f.severity) {
        const nf = next.findings.find((x) => x.id === f.id);
        if (nf) nf.severity = j.value;
      }
    });
    next.counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of next.findings) next.counts[f.severity]++;
  }

  /* ---------- narration under the lock ---------- */
  if (writer) {
    const narrative = await writer.narrate(next, tier, built);
    out.narrative = narrative;
    for (const [id, n] of Object.entries(narrative.findings)) {
      const nf = next.findings.find((x) => x.id === id);
      if (!nf) continue;
      if (n.why.source === "ai") nf.why = n.why.text;
      if (n.fix.source === "ai") nf.fix = { ...nf.fix, summary: n.fix.text };
    }
  }

  /* ---------- plan ---------- */
  out.plan = await aiPlan(out.plan, next, capture, built, tier, writer, out.judgments.businessModel, threshold);
  next.plan = out.plan;
  out.report = next;
  return out;
}

function degraded<T>(value: T): Judgment<T> {
  return { value, confidence: 0, tier: "jev", evidenceIds: [], degraded: "invalid" };
}

/* ------------------------------------------------------------------ */
/* Tracking plan                                                        */
/* ------------------------------------------------------------------ */

const EXPECTED: Record<ConversionType, Array<Pick<PlanEvent, "name" | "vendor">>> = {
  purchase: [
    { name: "view_item", vendor: "ga4" }, { name: "add_to_cart", vendor: "ga4" }, { name: "begin_checkout", vendor: "ga4" }, { name: "purchase", vendor: "ga4" },
    { name: "ViewContent", vendor: "meta" }, { name: "AddToCart", vendor: "meta" }, { name: "InitiateCheckout", vendor: "meta" }, { name: "Purchase", vendor: "meta" },
  ],
  lead: [{ name: "form_start", vendor: "ga4" }, { name: "generate_lead", vendor: "ga4" }, { name: "Lead", vendor: "meta" }],
  booking: [{ name: "generate_lead", vendor: "ga4" }, { name: "Schedule", vendor: "meta" }],
  signup: [{ name: "sign_up", vendor: "ga4" }, { name: "CompleteRegistration", vendor: "meta" }],
  contact_click: [{ name: "Contact", vendor: "meta" }],
  download: [{ name: "file_download", vendor: "ga4" }],
};

/**
 * Core conversion types per business model, listed even when we did not detect them.
 * Anything else is listed only when detected on the site. A type that is neither is never listed.
 */
const BY_MODEL: Record<BusinessModel, ConversionType[]> = {
  ecommerce: ["purchase"],
  lead_gen: ["lead", "contact_click"],
  saas: ["signup", "lead"],
  booking: ["booking", "contact_click"],
  content: ["lead"],
  local_service: ["lead", "contact_click"],
  other: [],
};

/** Funnel step (as walked by the browser) that exercises an event. Events not listed here are final steps we never perform. */
const STEP_OF_EVENT: Record<string, string> = {
  view_item: "view_item", add_to_cart: "add_to_cart", begin_checkout: "begin_checkout", form_start: "form_start",
  ViewContent: "view_item", AddToCart: "add_to_cart", InitiateCheckout: "begin_checkout", Contact: "click",
};

export const GA4_VOCAB = new Set([
  "page_view", "view_item_list", "view_item", "select_item", "add_to_cart", "remove_from_cart", "view_cart", "begin_checkout", "add_shipping_info",
  "add_payment_info", "purchase", "refund", "generate_lead", "qualify_lead", "sign_up", "login", "form_start", "form_submit", "file_download",
  "click", "search", "view_promotion", "select_promotion",
]);
export const META_VOCAB = new Set([
  "PageView", "ViewContent", "AddToCart", "InitiateCheckout", "AddPaymentInfo", "Purchase", "Lead", "CompleteRegistration", "Contact", "Schedule",
  "Subscribe", "StartTrial", "SubmitApplication", "Search",
]);

function heuristicModel(report: Report, capture: Capture | undefined): BusinessModel {
  const hints = (capture?.platformHints ?? []).join(" ").toLowerCase() + " " + report.stack.map((s) => s.name).join(" ").toLowerCase();
  const pts = new Set((capture?.conversionPoints ?? []).map((c) => c.type));
  for (const c of report.conversions) if (c.points.length) pts.add(c.type);
  if (/shopify|woocommerce|magento|prestashop/.test(hints) || pts.has("purchase")) return "ecommerce";
  if (pts.has("booking")) return "booking";
  if (pts.has("signup")) return "saas";
  if (pts.has("lead") || pts.has("contact_click")) return "lead_gen";
  return "other";
}

/** Event names seen in this scan (decoded hits, raw params en/ev, dataLayer events). */
export function observedEvents(built: BuiltIndex): Set<string> {
  const seen = new Set<string>();
  for (const it of built.index.values()) {
    const d = it.data as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    if (it.kind === "hit") {
      if (typeof d.event === "string") seen.add(d.event);
      const params = d.params as Record<string, unknown> | undefined;
      if (params && typeof params.en === "string") seen.add(params.en);
      if (params && typeof params.ev === "string") seen.add(params.ev);
      for (const b of (Array.isArray(d.body) ? d.body : []) as Array<Record<string, unknown>>) if (b && typeof b.en === "string") seen.add(b.en);
    }
    if (it.kind === "datalayer") {
      const p = d.payload as Record<string, unknown> | undefined;
      if (p && typeof p.event === "string") seen.add(p.event);
    }
  }
  return seen;
}

function conversionStatus(report: Report, t: ConversionType, tagsFailed: boolean): PlanStatus {
  const c = report.conversions.find((x) => x.type === t);
  if (!c) return "unknown";
  const st: PlanStatus = c.status === "ok" ? "tracked" : c.status === "partial" || c.status === "broken" ? "partial" : c.status === "not_tracked" ? "missing" : "unknown";
  return st === "missing" && tagsFailed ? "unknown" : st;
}

/** seen: a matching hit. missing: tags loaded AND the step was exercised. unknown: everything else. */
function eventStatus(e: Pick<PlanEvent, "name" | "conversionType">, seen: Set<string>, ctx: { loaded: boolean; walked: (t: ConversionType) => Set<string> }): PlanEventStatus {
  if (seen.has(e.name)) return "seen";
  if (!ctx.loaded) return "unknown";
  const step = STEP_OF_EVENT[e.name];
  return step && ctx.walked(e.conversionType).has(step) ? "missing" : "unknown";
}

function planContext(report: Report, capture: Capture | undefined, built: BuiltIndex) {
  const tagsFailed = report.findings.some((f) => f.id === "scan.tag_library_failed");
  const anyHit = [...built.index.values()].some((i) => i.kind === "hit");
  const loaded = !report.scan.aborted && !tagsFailed && anyHit;
  const walked = (t: ConversionType) => new Set((capture?.conversionPoints ?? []).filter((c) => c.type === t).flatMap((c) => c.walk).filter((w) => w.ok).map((w) => w.name));
  return { tagsFailed, loaded, walked };
}

function whyText(t: ConversionType, status: PlanStatus, detected: boolean, tagsFailed: boolean): string {
  let w = planWhyTemplate(t);
  if (tagsFailed) w += " Your tags did not load during our scan, so this was not tested.";
  else if (!detected) w += " We did not find this path on the pages we scanned.";
  else if (status === "unknown") w += " We could not test it from outside.";
  return w;
}

export function basePlan(report: Report, capture: Capture | undefined, built: BuiltIndex, model?: { value: BusinessModel; confidence: number; source: "rules" | "jev" | "claude" }): TrackingPlan {
  const bm = model ?? { value: heuristicModel(report, capture), confidence: 0.5, source: "rules" as const };
  const detected = new Set<ConversionType>();
  for (const c of report.conversions) if (c.points.length) detected.add(c.type);
  for (const c of capture?.conversionPoints ?? []) detected.add(c.type);
  const types = new Set<ConversionType>([...BY_MODEL[bm.value], ...detected]);
  const ctx = planContext(report, capture, built);
  const seen = observedEvents(built);
  const events: PlanEvent[] = [];
  const conversions = [...types].map((t) => {
    for (const e of EXPECTED[t]) {
      if (events.some((x) => x.name === e.name && x.vendor === e.vendor)) continue;
      events.push({ ...e, conversionType: t, status: eventStatus({ name: e.name, conversionType: t }, seen, ctx) });
    }
    const status = conversionStatus(report, t, ctx.tagsFailed);
    const cps = (capture?.conversionPoints ?? []).filter((c) => c.type === t).map((c) => `cp:${c.id}`);
    return { type: t, status, why: whyText(t, status, detected.has(t), ctx.tagsFailed), evidenceIds: ["r", ...cps] };
  });
  return { businessModel: bm, conversions, events };
}

async function aiPlan(
  base: TrackingPlan,
  report: Report,
  capture: Capture | undefined,
  built: BuiltIndex,
  tier: Tier,
  writer: AiWriter | undefined,
  jevModel: Judgment<BusinessModel> | undefined,
  threshold: number,
): Promise<TrackingPlan> {
  let model = base.businessModel;
  if (jevModel && jevModel.confidence >= threshold) model = { value: jevModel.value, confidence: jevModel.confidence, source: "jev" };
  let plan = model === base.businessModel ? base : basePlan(report, capture, built, model);
  if (!writer) return plan;

  const items = [...built.index.values()];
  const site: SiteSummary = {
    host: (items.find((i) => i.id === "r")?.data as { target?: string } | undefined)?.target ?? "",
    platformHints: capture?.platformHints ?? [],
    tags: items.filter((i) => i.kind === "stack").map((i) => ({ id: i.id, name: i.summary })),
    pages: items.filter((i) => i.kind === "page").slice(0, 10).map((i) => ({ id: i.id, title: (i.data as { title?: string })?.title, path: (i.data as { url?: string })?.url ?? "" })),
    conversionPoints: items.filter((i: EvidenceItem) => i.kind === "conversion_point").map((i) => ({ id: i.id, type: String((i.data as { type?: string })?.type ?? ""), label: i.summary })),
    observedEvents: [...observedEvents(built)].slice(0, 40),
    ...(model.source !== "rules" ? { businessModelHint: model.value } : {}),
  };
  const { draft, why } = await writer.inferPlan(site, tier, built.index);
  if (!draft) return plan;
  if (model.source === "rules") {
    model = { value: draft.businessModel, confidence: 0.6, source: "claude" };
    plan = basePlan(report, capture, built, model);
  }
  const seen = observedEvents(built);
  const ctx = planContext(report, capture, built);
  const listed = new Set(plan.conversions.map((c) => c.type));
  // The draft may reword the "why" of listed conversions, but never adds a type the site neither has nor needs.
  for (const c of plan.conversions) {
    const w = why[c.type];
    if (w?.source === "ai") c.why = w.text, c.evidenceIds = w.evidenceIds;
  }
  for (const e of draft.events) {
    const ok = e.vendor === "ga4" ? GA4_VOCAB.has(e.name) : META_VOCAB.has(e.name);
    if (!ok || !e.conversionType || !listed.has(e.conversionType) || plan.events.some((x) => x.name === e.name && x.vendor === e.vendor)) continue;
    plan.events.push({ name: e.name, vendor: e.vendor, conversionType: e.conversionType, status: eventStatus({ name: e.name, conversionType: e.conversionType }, seen, ctx) });
  }
  return plan;
}

export type { ConversionPoint };
