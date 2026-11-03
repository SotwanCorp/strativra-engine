/**
 * Ranking: score = impact x confidence x reach (max 45).
 * Ties: lower effort first, then higher severity, then id (stable output).
 * Top 3 come only from reproduced findings.
 */
import type { Finding, Severity } from "../types.ts";

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const TOP_N = 3;

export function score(f: Finding): number {
  return f.impact * f.confidence * f.reach;
}

export function compareFindings(a: Finding, b: Finding): number {
  return score(b) - score(a) || a.effort - b.effort || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id);
}

const EFFORT_WORD: Record<1 | 2 | 3, string> = { 1: "a quick fix", 2: "a moderate fix", 3: "a larger fix" };
const REACH_WORD: Record<1 | 2 | 3, string> = { 1: "a few pages", 2: "part of the site", 3: "most of the site" };

function whyRanked(f: Finding, pos: number): string {
  return `#${pos}: score ${score(f)} of 45 (impact ${f.impact}, confidence ${f.confidence}, reach ${f.reach}). Reproduced in this scan, affects ${REACH_WORD[f.reach]}, ${EFFORT_WORD[f.effort]}.`;
}

export function rank(findings: Finding[]): { findings: Finding[]; top: string[]; notes: Record<string, string> } {
  const sorted = [...findings].sort(compareFindings);
  const top = sorted.filter((f) => f.reproduced).slice(0, TOP_N);
  const notes: Record<string, string> = {};
  top.forEach((f, i) => {
    notes[f.id] = whyRanked(f, i + 1);
  });
  return { findings: sorted, top: top.map((f) => f.id), notes };
}
