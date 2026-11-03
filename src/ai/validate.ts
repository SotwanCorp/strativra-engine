/**
 * The evidence lock. No AI sentence reaches a client unless:
 * 1. it cites at least one evidence id, and every cited id exists in this scan's index;
 * 2. every event name, domain and number in its text appears in the cited evidence;
 * 3. it has no em/en dashes and no prices or currency amounts;
 * 4. (optional gate 2) Jev says the cited evidence `supports` it with high confidence.
 * A failing claim gets one repair round with the errors, then it is replaced by
 * the deterministic template text.
 */
import type { AiJudge } from "./judge.ts";
import { pick } from "./redact.ts";
import type { CitedClaim, EvidenceIndex, LockedClaim } from "./types.ts";

export interface ClaimError {
  code: "no_citation" | "unknown_id" | "uncited_event" | "uncited_domain" | "uncited_number" | "dash" | "price" | "empty" | "not_supported";
  detail: string;
}

/** snake_case tokens: purchase, generate_lead, transaction_id (single words are too common to check). */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
/** Meta standard events (CamelCase), checked even though they are not snake_case. */
const META_EVENTS = /\b(PageView|ViewContent|AddToCart|AddToWishlist|InitiateCheckout|AddPaymentInfo|Purchase|Lead|CompleteRegistration|Contact|Schedule|Subscribe|StartTrial|SubmitApplication|Search|FindLocation|CustomizeProduct|Donate)\b/g;
const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
const NUMBER = /\d+(?:[.,]\d+)*/g;
const DASH = /[‒–—―−]/;
const PRICE = /[$€£¥₹]\s?\d|\d\s?[$€£¥₹]|\b\d+(?:[.,]\d+)?\s?(?:USD|EUR|GBP|TND|CHF|CAD|AUD|dollars?|euros?|pounds?|dinars?)\b|\b(?:USD|EUR|GBP|TND|CHF)\s?\d/i;
/** Words that look like domains but are file names or code. */
const NOT_DOMAIN = /\.(?:js|png|jpe?g|json|php|html?|css|svg|ts)$/i;

export function claimErrors(claim: CitedClaim, index: EvidenceIndex): ClaimError[] {
  const errs: ClaimError[] = [];
  const text = (claim.text ?? "").trim();
  if (!text) errs.push({ code: "empty", detail: "Empty text." });
  const ids = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
  if (ids.length === 0) errs.push({ code: "no_citation", detail: "Cite at least one evidence id." });
  const unknown = ids.filter((id) => !index.has(id));
  for (const id of unknown) errs.push({ code: "unknown_id", detail: `Evidence id ${id} does not exist in this scan.` });

  const cited = pick(index, ids.filter((id) => index.has(id)))
    .map((i) => i.text)
    .join(" \n ");

  if (DASH.test(text)) errs.push({ code: "dash", detail: "Remove em dashes and en dashes; use a comma, colon or full stop." });
  if (PRICE.test(text)) errs.push({ code: "price", detail: "Remove prices and currency amounts." });

  const seen = new Set<string>();
  const once = (k: string) => (seen.has(k) ? false : (seen.add(k), true));

  for (const m of text.match(SNAKE) ?? []) {
    if (once("e:" + m) && !cited.includes(m.toLowerCase())) errs.push({ code: "uncited_event", detail: `"${m}" is not in the cited evidence.` });
  }
  for (const m of text.match(META_EVENTS) ?? []) {
    if (once("e:" + m) && !cited.includes(m.toLowerCase())) errs.push({ code: "uncited_event", detail: `"${m}" is not in the cited evidence.` });
  }
  for (const m of text.match(DOMAIN) ?? []) {
    if (NOT_DOMAIN.test(m) || /^\d/.test(m)) continue;
    if (!/[a-z]{2,}\.[a-z]{2,}/i.test(m)) continue; // e.g. "e.g", "i.e"
    if (once("d:" + m) && !cited.includes(m.toLowerCase())) errs.push({ code: "uncited_domain", detail: `"${m}" is not in the cited evidence.` });
  }
  for (const m of text.match(NUMBER) ?? []) {
    if (!once("n:" + m)) continue;
    const variants = [m, m.replace(",", "."), m.replace(/,/g, "")];
    if (!variants.some((v) => cited.includes(v))) errs.push({ code: "uncited_number", detail: `The number ${m} is not in the cited evidence.` });
  }
  return errs;
}

/** Errors per claim key. Empty arrays mean the claim passed. */
export function validateClaims<K extends string>(claims: Record<K, CitedClaim>, index: EvidenceIndex): Record<K, ClaimError[]> {
  const out = {} as Record<K, ClaimError[]>;
  for (const k of Object.keys(claims) as K[]) out[k] = claimErrors(claims[k], index);
  return out;
}

/** Same check for a deterministic template: must at least cite real ids. */
function templateOk(c: CitedClaim, index: EvidenceIndex): boolean {
  return c.evidenceIds.length > 0 && c.evidenceIds.every((id) => index.has(id));
}

export interface LockOptions {
  /** Optional gate 2: Jev double-checks each surviving claim. */
  judge?: AiJudge;
  /** Accept only `supports` at or above this Jev confidence. Default: judge.threshold (0.8). */
  supportThreshold?: number;
}

export interface LockResult<K extends string> {
  claims: Record<K, LockedClaim>;
  /** Keys that fell back to the template, with the last errors. Internal only. */
  rejected: Partial<Record<K, ClaimError[]>>;
  repaired: boolean;
}

export type Generate<K extends string> = (repair?: Partial<Record<K, ClaimError[]>>) => Promise<Partial<Record<K, CitedClaim>> | undefined>;

/**
 * generate -> validate -> one repair round with the errors -> keep the claims
 * that pass, replace the rest with the deterministic template.
 * `fallback` must have a key for every claim the caller needs. Never throws.
 */
export async function lockedGenerate<K extends string>(
  generate: Generate<K>,
  index: EvidenceIndex,
  fallback: Record<K, CitedClaim>,
  opts: LockOptions = {},
): Promise<LockResult<K>> {
  const keys = Object.keys(fallback) as K[];
  const accepted = new Map<K, CitedClaim>();
  let errors: Partial<Record<K, ClaimError[]>> = {};
  let repaired = false;

  const run = async (repair?: Partial<Record<K, ClaimError[]>>) => {
    let out: Partial<Record<K, CitedClaim>> | undefined;
    try {
      out = await generate(repair);
    } catch {
      out = undefined;
    }
    const next: Partial<Record<K, ClaimError[]>> = {};
    for (const k of keys) {
      if (accepted.has(k)) continue;
      const c = out?.[k];
      if (!c) {
        next[k] = [{ code: "empty", detail: "Missing." }];
        continue;
      }
      const e = claimErrors(c, index);
      if (e.length === 0) accepted.set(k, { text: c.text.trim(), evidenceIds: [...new Set(c.evidenceIds)] });
      else next[k] = e;
    }
    return { next, produced: out !== undefined };
  };

  const first = await run();
  errors = first.next;
  if (first.produced && Object.keys(errors).length > 0) {
    repaired = true;
    errors = (await run(errors)).next;
  }

  // Gate 2: Jev supports / contradicts / unrelated, one batched request.
  if (opts.judge && accepted.size > 0) {
    const ks = [...accepted.keys()];
    const verdicts = await opts.judge.supportsMany(ks.map((k) => ({ text: accepted.get(k)!.text, evidence: pick(index, accepted.get(k)!.evidenceIds) })));
    const min = opts.supportThreshold ?? opts.judge.threshold;
    ks.forEach((k, i) => {
      const v = verdicts[i];
      // A degraded gate (no client, budget, error) does not block: gate 1 already passed.
      if (v.degraded) return;
      if (v.value !== "supports" || v.confidence < min) {
        accepted.delete(k);
        errors[k] = [{ code: "not_supported", detail: `Jev: ${v.value} (${v.confidence.toFixed(2)})` }];
      }
    });
  }

  const claims = {} as Record<K, LockedClaim>;
  const rejected: Partial<Record<K, ClaimError[]>> = {};
  for (const k of keys) {
    const a = accepted.get(k);
    if (a) claims[k] = { ...a, source: "ai" };
    else {
      const fb = fallback[k];
      claims[k] = { text: fb.text, evidenceIds: templateOk(fb, index) ? fb.evidenceIds : fb.evidenceIds.filter((id) => index.has(id)), source: "template" };
      if (errors[k]) rejected[k] = errors[k];
    }
  }
  return { claims, rejected, repaired };
}

/** Copy check for any text (template or AI) before it is shown. */
export function copyErrors(text: string): ClaimError[] {
  const e: ClaimError[] = [];
  if (DASH.test(text)) e.push({ code: "dash", detail: "dash" });
  if (PRICE.test(text)) e.push({ code: "price", detail: "price" });
  return e;
}
