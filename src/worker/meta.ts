import { SOURCES, TRIGGERS } from "./queue.ts";
import type { Source, Trigger } from "./queue.ts";

/** Opaque ids the platform sends so it can match the webhook to its own rows. Never PII. */
export const REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface JobMeta {
  source: Source;
  trigger: Trigger;
  accountRef?: string;
  siteRef?: string;
  /** false skips AI enrichment (unverified sites, budget). Default true. */
  ai: boolean;
}

export type MetaResult = { ok: true; meta: JobMeta } | { ok: false; error: string; detail: string };

const absent = (v: unknown) => v === undefined || v === null;

/**
 * Optional job metadata from a request body: {source, trigger, accountRef, siteRef, ai}.
 * `fixed` pins source and trigger (captures are always extension / upload): a different value is an error.
 */
export function parseMeta(body: Record<string, unknown>, d: { source: Source; trigger: Trigger; fixed?: boolean }): MetaResult {
  const fail = (error: string, detail: string): MetaResult => ({ ok: false, error, detail });
  let source = d.source;
  if (!absent(body.source)) {
    if (typeof body.source !== "string" || !(SOURCES as readonly string[]).includes(body.source)) return fail("invalid_source", `source must be one of ${SOURCES.join(", ")}`);
    if (d.fixed && body.source !== d.source) return fail("invalid_source", `source must be ${d.source} here`);
    source = body.source as Source;
  }
  let trigger = d.trigger;
  if (!absent(body.trigger)) {
    if (typeof body.trigger !== "string" || !(TRIGGERS as readonly string[]).includes(body.trigger)) return fail("invalid_trigger", `trigger must be one of ${TRIGGERS.join(", ")}`);
    if (d.fixed && body.trigger !== d.trigger) return fail("invalid_trigger", `trigger must be ${d.trigger} here`);
    trigger = body.trigger as Trigger;
  }
  const meta: JobMeta = { source, trigger, ai: true };
  for (const [key, err] of [["accountRef", "invalid_account_ref"], ["siteRef", "invalid_site_ref"]] as const) {
    if (absent(body[key])) continue;
    const v = body[key];
    if (typeof v !== "string" || !REF_RE.test(v)) return fail(err, `${key} must be 1 to 64 characters of A-Z a-z 0-9 _ -`);
    meta[key] = v;
  }
  if (!absent(body.ai)) {
    if (typeof body.ai !== "boolean") return fail("invalid_ai", "ai must be true or false");
    meta.ai = body.ai;
  }
  return { ok: true, meta };
}

/** True when the body carries any field only an authenticated caller may set. */
export function hasPlatformFields(body: Record<string, unknown>): boolean {
  return ["source", "trigger", "accountRef", "siteRef"].some((k) => !absent(body[k]));
}
