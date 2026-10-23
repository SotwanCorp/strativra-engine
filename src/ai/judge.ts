/**
 * AiJudge: typed, calibrated decisions from Jev (TypeSafe AI "System One").
 *
 * The client is injected (a real `TypeSafeClient` satisfies `JevClient`).
 * One `systemOne` request per scan stage (`batch`), many named questions over
 * one redacted `state`. Errors never throw into the pipeline: they come back
 * as a degraded result and the caller keeps the deterministic value.
 */
import {
  APIConnectionError,
  APITimeoutError,
  RateLimitError,
  choice,
  noul,
  score,
} from "@typesafe-ai/sdk";
import type {
  ChoiceResponse,
  EntryType,
  NoulResponse,
  Questions,
  RequestOptions,
  ScoreResponse,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";
import type { ScanBudget } from "./budget.ts";
import { forPrompt } from "./redact.ts";
import type { DegradeReason, EvidenceItem, Judgment, Severity, SeverityDetail } from "./types.ts";

/** The slice of `TypeSafeClient` we use. Fakes implement this in tests. */
export interface JevClient {
  systemOne(request: SystemOneRequest<Questions>, options?: RequestOptions): PromiseLike<SystemOneResult<Questions>>;
}

export type JevAnswer = SystemOneResult<Questions>["answers"][string];

export type BatchResult =
  | { ok: true; answers: Record<string, JevAnswer>; model: string }
  | { ok: false; reason: DegradeReason };

export interface JudgeOptions {
  budget?: ScanBudget;
  /** Default "jev-latest" (the client default). */
  model?: string;
  /** Per-attempt timeout ms. The SDK default is 10s with 2 retries. */
  timeoutMs?: number;
  /** Accept threshold on Jev confidence. Default 0.8, to be calibrated on a labelled set. */
  threshold?: number;
}

/** State given to Jev: redacted evidence items only, plus a short context line. */
export function jevState(context: string, items: EvidenceItem[]): NonNullable<EntryType> {
  return { context, evidence: forPrompt(items) } as unknown as NonNullable<EntryType>;
}

export function classifyError(e: unknown): DegradeReason {
  if (e instanceof RateLimitError) return "rate_limit";
  if (e instanceof APITimeoutError) return "timeout";
  if (e instanceof APIConnectionError) return "timeout";
  if (e && typeof e === "object" && "status" in e && (e as { status: unknown }).status === 429) return "rate_limit";
  if (e instanceof Error && /timeout|timed out/i.test(e.name + " " + e.message)) return "timeout";
  return "error";
}

/* ------------------------------------------------------------------ */
/* Answer -> Judgment                                                   */
/* ------------------------------------------------------------------ */

export function fromNoul(a: JevAnswer | undefined, evidenceIds: string[]): Judgment<boolean> | undefined {
  if (!a || a.type !== "noul") return undefined;
  const p = (a as NoulResponse).noul;
  if (typeof p !== "number" || !Number.isFinite(p)) return undefined;
  return { value: p >= 0.5, confidence: Math.abs(p - 0.5) * 2, tier: "jev", evidenceIds, detail: { p } };
}

export function fromChoice<L extends string>(a: JevAnswer | undefined, labels: readonly L[], evidenceIds: string[]): Judgment<L> | undefined {
  if (!a || a.type !== "choice") return undefined;
  const c = a as ChoiceResponse;
  if (!labels.includes(c.choice as L)) return undefined;
  return { value: c.choice as L, confidence: c.confidence ?? 0, tier: "jev", evidenceIds, detail: { ...c.probabilities } };
}

/**
 * Score: `value` keeps Jev's float (expected value over the rubric levels, e.g. 2.98);
 * `detail.level` is the argmax of the probabilities, for display and audits.
 */
export function fromScore(a: JevAnswer | undefined, evidenceIds: string[]): Judgment<number> | undefined {
  if (!a || a.type !== "score") return undefined;
  const s = a as ScoreResponse;
  if (typeof s.score !== "number" || !Number.isFinite(s.score)) return undefined;
  return { value: s.score, confidence: s.confidence ?? 0, tier: "jev", evidenceIds, detail: { score: s.score, level: argmaxLevel(s.probabilities, s.score) } };
}

export function argmaxLevel(probs: Record<string, number> | undefined, fallback: number): number {
  let best = -1;
  let level = Math.round(fallback);
  for (const [k, p] of Object.entries(probs ?? {})) {
    if (typeof p === "number" && p > best) {
      best = p;
      level = Number(k);
    }
  }
  return level;
}

/* ------------------------------------------------------------------ */
/* Severity composite                                                   */
/* ------------------------------------------------------------------ */

/** 0..3 rubric shared by the atomic severity questions. */
export const IMPACT_RUBRIC = ["none", "minor", "significant", "severe"] as const;

export const SEVERITY_WEIGHTS = { dataLoss: 0.35, attribution: 0.3, compliance: 0.25, reach: 0.1 } as const;

export const SEVERITY_QUESTIONS = {
  dataLoss: "How much conversion or analytics data is lost or corrupted because of this finding?",
  attribution: "How much does this finding damage ad platform attribution and bidding (conversions credited to the wrong source, or not at all)?",
  compliance: "How much privacy or consent compliance risk does this finding create (tracking without valid consent, personal data sent to vendors)?",
  reach: "How much of the site's traffic or conversions does this finding affect?",
} as const;

export type SeverityAxis = keyof typeof SEVERITY_WEIGHTS;

const LEVELS: Severity[] = ["low", "medium", "high", "critical"];

/** Deterministic, auditable: weighted mean of 0..3 scores -> level. */
export function compositeSeverity(scores: Record<SeverityAxis, number>): { level: Severity; composite: number } {
  let c = 0;
  for (const k of Object.keys(SEVERITY_WEIGHTS) as SeverityAxis[]) c += SEVERITY_WEIGHTS[k] * Math.max(0, Math.min(3, scores[k]));
  const level: Severity = c >= 2.25 ? "critical" : c >= 1.5 ? "high" : c >= 0.75 ? "medium" : "low";
  return { level, composite: Math.round(c * 1000) / 1000 };
}

/** Jev may move severity by at most one level from the rules. */
export function clampOneLevel(rules: Severity, proposed: Severity): Severity {
  const r = LEVELS.indexOf(rules);
  const p = LEVELS.indexOf(proposed);
  return LEVELS[Math.max(r - 1, Math.min(r + 1, p))];
}

/** Turn the four atomic answers into a severity judgment. Confidence = lowest axis confidence. */
export function severityFromAnswers(
  rulesSeverity: Severity,
  answers: Partial<Record<SeverityAxis, JevAnswer>>,
  evidenceIds: string[],
): Judgment<Severity> | undefined {
  const scores = {} as Record<SeverityAxis, number>;
  let conf = 1;
  for (const k of Object.keys(SEVERITY_WEIGHTS) as SeverityAxis[]) {
    const j = fromScore(answers[k], evidenceIds);
    if (!j) return undefined;
    scores[k] = j.value;
    conf = Math.min(conf, j.confidence);
  }
  const { level, composite } = compositeSeverity(scores);
  const detail: SeverityDetail = { ...scores, composite };
  return { value: clampOneLevel(rulesSeverity, level), confidence: conf, tier: "jev", evidenceIds, detail: { ...detail } };
}

/* ------------------------------------------------------------------ */
/* Supports gate                                                        */
/* ------------------------------------------------------------------ */

export const SUPPORT_LABELS = ["supports", "contradicts", "unrelated"] as const;
export type SupportLabel = (typeof SUPPORT_LABELS)[number];

export function supportsQuestion(claim: string, citedIds: string[]) {
  return choice(
    { task: "Double-check this citation. Read only the evidence items listed in cited. Does that evidence support the claim?", claim, cited: citedIds },
    {
      supports: "The cited evidence directly shows what the claim says.",
      contradicts: "The cited evidence shows something different from the claim.",
      unrelated: "The cited evidence does not show this, or the claim adds facts that are not in it.",
    },
  );
}

/* ------------------------------------------------------------------ */
/* Judge                                                                */
/* ------------------------------------------------------------------ */

export class AiJudge {
  readonly client?: JevClient;
  readonly budget?: ScanBudget;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly threshold: number;

  constructor(client: JevClient | undefined, opts: JudgeOptions = {}) {
    this.client = client;
    this.budget = opts.budget;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
    this.threshold = opts.threshold ?? 0.8;
  }

  /** One request for one stage. Never throws. */
  async batch(req: { state: NonNullable<EntryType>; questions: Questions }): Promise<BatchResult> {
    if (!this.client) return { ok: false, reason: "no_client" };
    if (Object.keys(req.questions).length === 0) return { ok: true, answers: {}, model: "" };
    if (this.budget && !this.budget.allowJev()) return { ok: false, reason: "budget" };
    try {
      const res = await this.client.systemOne(
        { state: req.state, questions: req.questions, ...(this.model ? { model: this.model } : {}) },
        this.timeoutMs ? { timeout: this.timeoutMs } : undefined,
      );
      this.budget?.recordJev(res.usage);
      return { ok: true, answers: { ...res.answers } as Record<string, JevAnswer>, model: res.model };
    } catch (e) {
      // A failed call may still have been billed; count it against the cap.
      this.budget?.recordJev();
      return { ok: false, reason: classifyError(e) };
    }
  }

  #degraded<T>(value: T, reason: DegradeReason, evidenceIds: string[]): Judgment<T> {
    return { value, confidence: 0, tier: "jev", evidenceIds, degraded: reason };
  }

  /**
   * Yes/no. Default asks a 2-option `choice` (yes/no), which reports a real
   * confidence; `via: "noul"` asks Noul and derives confidence = |p - 0.5| * 2.
   */
  async yesNo(
    items: EvidenceItem[],
    instructions: string,
    opts: { fallback: boolean; via?: "choice" | "noul"; context?: string },
  ): Promise<Judgment<boolean>> {
    const ids = items.map((i) => i.id);
    const q = opts.via === "noul" ? noul(instructions) : choice(instructions, { yes: null, no: null });
    const r = await this.batch({ state: jevState(opts.context ?? "", items), questions: { q } });
    if (!r.ok) return this.#degraded(opts.fallback, r.reason, ids);
    const j = opts.via === "noul" ? fromNoul(r.answers.q, ids) : yesNoFromChoice(r.answers.q, ids);
    return j ?? this.#degraded(opts.fallback, "invalid", ids);
  }

  async pick<L extends string>(
    items: EvidenceItem[],
    instructions: string,
    labels: Record<L, string | null>,
    opts: { fallback: NoInfer<L>; context?: string },
  ): Promise<Judgment<L>> {
    const ids = items.map((i) => i.id);
    const r = await this.batch({ state: jevState(opts.context ?? "", items), questions: { q: choice(instructions, labels) } });
    if (!r.ok) return this.#degraded(opts.fallback, r.reason, ids);
    return fromChoice(r.answers.q, Object.keys(labels) as L[], ids) ?? this.#degraded(opts.fallback, "invalid", ids);
  }

  async rate(
    items: EvidenceItem[],
    instructions: string,
    rubric: readonly string[],
    opts: { fallback: number; context?: string },
  ): Promise<Judgment<number>> {
    const ids = items.map((i) => i.id);
    const r = await this.batch({ state: jevState(opts.context ?? "", items), questions: { q: score(instructions, rubric as string[]) } });
    if (!r.ok) return this.#degraded(opts.fallback, r.reason, ids);
    return fromScore(r.answers.q, ids) ?? this.#degraded(opts.fallback, "invalid", ids);
  }

  /** Gate 2 for one claim. For many claims use `supportsMany` (one request). */
  async supports(claim: string, evidence: EvidenceItem[]): Promise<Judgment<SupportLabel>> {
    const res = await this.supportsMany([{ text: claim, evidence }]);
    return res[0];
  }

  /** One batched request: one supports/contradicts/unrelated choice per claim. */
  async supportsMany(claims: Array<{ text: string; evidence: EvidenceItem[] }>): Promise<Judgment<SupportLabel>[]> {
    const all = new Map<string, EvidenceItem>();
    for (const c of claims) for (const e of c.evidence) all.set(e.id, e);
    const questions: Questions = {};
    claims.forEach((c, i) => {
      questions[`c${i}`] = supportsQuestion(c.text, c.evidence.map((e) => e.id));
    });
    const r = await this.batch({ state: jevState("Evidence captured by a tracking audit scan.", [...all.values()]), questions });
    return claims.map((c, i) => {
      const ids = c.evidence.map((e) => e.id);
      if (!r.ok) return this.#degraded<SupportLabel>("unrelated", r.reason, ids);
      return fromChoice(r.answers[`c${i}`], SUPPORT_LABELS, ids) ?? this.#degraded<SupportLabel>("unrelated", "invalid", ids);
    });
  }

  /** Composite severity from four atomic scores, clamped to one level from the rules. */
  async severity(finding: { id: string; title: string; severity: Severity }, evidence: EvidenceItem[]): Promise<Judgment<Severity>> {
    const ids = evidence.map((e) => e.id);
    const questions = severityQuestions(`f`, finding.title);
    const r = await this.batch({ state: jevState("A tracking audit finding and its evidence.", evidence), questions });
    if (!r.ok) return { value: finding.severity, confidence: 0, tier: "jev", evidenceIds: ids, degraded: r.reason };
    return (
      severityFromAnswers(finding.severity, pickAxes(r.answers, "f"), ids) ??
      { value: finding.severity, confidence: 0, tier: "jev", evidenceIds: ids, degraded: "invalid" }
    );
  }
}

export function yesNoFromChoice(a: JevAnswer | undefined, ids: string[]): Judgment<boolean> | undefined {
  const j = fromChoice(a, ["yes", "no"] as const, ids);
  return j ? { ...j, value: j.value === "yes" } : undefined;
}

export function severityQuestions(prefix: string, title: string): Questions {
  const q: Questions = {};
  for (const k of Object.keys(SEVERITY_QUESTIONS) as SeverityAxis[]) {
    q[`${prefix}_${k}`] = score({ finding: title, question: SEVERITY_QUESTIONS[k] }, [...IMPACT_RUBRIC]);
  }
  return q;
}

export function pickAxes(answers: Record<string, JevAnswer>, prefix: string): Partial<Record<SeverityAxis, JevAnswer>> {
  const out: Partial<Record<SeverityAxis, JevAnswer>> = {};
  for (const k of Object.keys(SEVERITY_WEIGHTS) as SeverityAxis[]) out[k] = answers[`${prefix}_${k}`];
  return out;
}
