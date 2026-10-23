/**
 * Types local to the AI layer. The shared contract stays in src/types.ts;
 * proposed additions there are listed in the AI layer hand-off notes.
 */
import type { ConversionType, ReportKind, Severity, Vendor } from "../types.ts";

/** "free" uses Jev + a small Claude model under a strict budget, "paid" the strongest model. */
export type Tier = ReportKind;

/* ------------------------------------------------------------------ */
/* Evidence                                                             */
/* ------------------------------------------------------------------ */

export type EvidenceKind =
  | "hit"
  | "datalayer"
  | "screenshot"
  | "cookie"
  | "page"
  | "finding"
  | "conversion_point"
  | "stack"
  | "report";

/** A JSON value after redaction (no undefined, no functions). */
export type JsonSafe = string | number | boolean | null | JsonSafe[] | { [key: string]: JsonSafe };

/** One compact, redacted evidence item. This is all an AI model ever sees. */
export interface EvidenceItem {
  /** h12 (hit), d3 (dataLayer), s2 (screenshot), c5 (cookie), p1 (page), f:<findingId>, cp:<id>, t1 (stack), r (report). */
  id: string;
  kind: EvidenceKind;
  /** One short redacted line. */
  summary: string;
  data?: JsonSafe;
  /** Lower-cased JSON of summary + data. Used by the validator for "appears in evidence" checks. */
  text: string;
}

/** id -> redacted evidence item. Insertion order is deterministic. */
export type EvidenceIndex = Map<string, EvidenceItem>;

/* ------------------------------------------------------------------ */
/* Judgments and claims                                                 */
/* ------------------------------------------------------------------ */

export type JudgmentTier = "rules" | "jev" | "claude" | "review";

/** Why an AI step produced no usable answer. Internal only; never shown in a report. */
export type DegradeReason = "no_client" | "budget" | "rate_limit" | "timeout" | "error" | "invalid";

export interface Judgment<T> {
  value: T;
  /** 0..1. Jev choice/score confidence, |p - 0.5| * 2 for noul, rules-defined for rules. */
  confidence: number;
  tier: JudgmentTier;
  evidenceIds: string[];
  /** Free tier: unresolved, shown as "Needs a closer look". */
  needsCloserLook?: boolean;
  /** Set when the AI step failed and `value` is the deterministic default. */
  degraded?: DegradeReason;
  /** Raw distribution or composite detail, for audit logs. */
  detail?: Record<string, number>;
}

/** Every AI sentence carries at least one evidence id from this scan. */
export interface CitedClaim {
  text: string;
  evidenceIds: string[];
}

/** A claim as it leaves the lock: AI text that passed, or the deterministic template. */
export interface LockedClaim extends CitedClaim {
  source: "ai" | "template";
}

/* ------------------------------------------------------------------ */
/* Inferred tracking plan                                               */
/* ------------------------------------------------------------------ */

export type BusinessModel = "ecommerce" | "lead_gen" | "saas" | "booking" | "content" | "local_service" | "other";

export type PlanStatus = "tracked" | "partial" | "missing" | "unknown";

export interface PlanEvent {
  /** From a fixed vocabulary (GA4 recommended + Meta standard events), never free text. */
  name: string;
  vendor: Extract<Vendor, "ga4" | "meta">;
  conversionType?: ConversionType;
  status: PlanStatus;
}

export interface PlanConversion {
  type: ConversionType;
  status: PlanStatus;
  why: LockedClaim;
}

/** No values, no volumes, no numbers. The paid audit asks the client for real values. */
export interface TrackingPlan {
  businessModel: { value: BusinessModel; confidence: number; source: "rules" | "jev" | "claude" };
  conversions: PlanConversion[];
  events: PlanEvent[];
}

/* ------------------------------------------------------------------ */
/* Narrative                                                            */
/* ------------------------------------------------------------------ */

export interface Narrative {
  summary: LockedClaim[];
  findings: Record<string, { why: LockedClaim; fix: LockedClaim }>;
}

export interface SeverityDetail {
  dataLoss: number;
  attribution: number;
  compliance: number;
  reach: number;
  composite: number;
}

export type { ConversionType, Severity };
