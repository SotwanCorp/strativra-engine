/**
 * Fix pack and explorer (paid, next phase). Interfaces only, so the pipeline
 * and the report can code against them now.
 *
 * Fix pack rules (SPEC 9): merge-safe GTM container JSON (exportFormatVersion 2),
 * prefixed names, never overwrite, never invent measurement or conversion ids
 * (placeholders + a checklist); platform snippets where GTM cannot fix it;
 * the tracking plan as a sheet; a verify-after-fix re-scan with the same evidence lock.
 *
 * Explorer rules: a plain Messages API tool loop (not the Agent SDK) over our own
 * guarded browser tools; never submit, never pay; step and token budget.
 */
import type { Finding, Report } from "../types.ts";
import type { ScanBudget } from "./budget.ts";
import type { CitedClaim, EvidenceIndex, TrackingPlan } from "./types.ts";

export interface GtmContainerPatch {
  exportFormatVersion: 2;
  /** Prefix for every created tag, trigger and variable, e.g. "STV - ". */
  namePrefix: string;
  containerVersion: Record<string, unknown>;
  /** Ids the client must fill in (measurement ids, conversion labels). Never invented. */
  placeholders: Array<{ token: string; meaning: string }>;
  diff: Array<{ op: "add"; kind: "tag" | "trigger" | "variable"; name: string }>;
}

export interface PlatformSnippet {
  platform: "shopify" | "webflow" | "wordpress" | "react" | "other";
  findingIds: string[];
  code: string;
  where: CitedClaim;
}

export interface FixPack {
  gtm?: GtmContainerPatch;
  snippets: PlatformSnippet[];
  plan: TrackingPlan;
  checklist: CitedClaim[];
}

export interface FixPackWriter {
  generate(report: Report, findings: Finding[], plan: TrackingPlan, index: EvidenceIndex, budget: ScanBudget): Promise<FixPack>;
}

/** Guarded browser tools the explorer may call. Implemented by src/browser (never submit, never pay). */
export interface ExplorerTools {
  navigate(url: string): Promise<{ ok: boolean; evidenceIds: string[] }>;
  click(selector: string): Promise<{ ok: boolean; blocked?: string; evidenceIds: string[] }>;
  focus(selector: string): Promise<{ ok: boolean; evidenceIds: string[] }>;
  snapshot(): Promise<{ evidenceIds: string[] }>;
}

export interface ExplorerResult {
  steps: number;
  notes: CitedClaim[];
  stoppedBecause: "done" | "budget" | "guard" | "error";
}

export interface Explorer {
  explore(goal: string, tools: ExplorerTools, budget: ScanBudget, maxSteps: number): Promise<ExplorerResult>;
}

/** TODO(paid, next phase): GTM container generator. */
export const notImplementedFixPack: FixPackWriter = {
  async generate() {
    throw new Error("Fix pack is not built yet (paid, next phase).");
  },
};

/** TODO(paid, next phase): Messages API tool loop over ExplorerTools. */
export const notImplementedExplorer: Explorer = {
  async explore() {
    return { steps: 0, notes: [], stoppedBecause: "done" };
  },
};
