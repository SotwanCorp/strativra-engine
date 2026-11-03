/**
 * Capture uploads: a recording made in the person's own browser (Chrome extension) becomes a
 * Capture the rules understand. Two pure steps, no network and no browser anywhere:
 *
 * 1. parseCaptureUpload(body): strict validation (types checked, unknown fields dropped, caps
 *    enforced) and re-redaction. The extension redacts on the client, but the engine never trusts it.
 * 2. applyUpload(upload): consent runs split into before/after the click, guided steps mapped onto
 *    conversion points, and the `Recording` block the report lists.
 *
 * Redaction here is the capture-level cousin of src/ai/redact.ts (which prepares evidence for the AI
 * and is stricter) and of the INIT_SCRIPT dataLayer rules. The rules and decoders must still work on
 * the result, so request URLs keep their shape: only PII-like param VALUES are replaced, never the
 * keys, and long ids (Ads account, Meta pixel) are left alone.
 *
 *  - emails (also %40-encoded) become "[email]" everywhere
 *  - values under PII-like keys (cid, uid, em, ph, ud[...], email, phone, token, ...) become "[redacted]"
 *  - dataLayer payloads and free text: digit runs of 9+ become "[digits:<hash>]" (equality survives)
 *  - cookie values, screenshots, request/response headers and credentials in URLs are never kept
 *  - request bodies survive only for requests a decoder recognises as tracking
 */
import { isPiiKey } from "../ai/redact.ts";
import type {
  BannerOutcome,
  Capture,
  CapturedRequest,
  ConsentKey,
  ConsentPhase,
  ConsentValue,
  ConversionPoint,
  ConversionType,
  CookieRecord,
  DataLayerPush,
  FunnelStep,
  PageVisit,
  Recording,
  Scenario,
  ScenarioRun,
} from "../types.ts";
import { decodeRequest } from "./decode/index.ts";
import { hostOf, normUrl } from "./rules/helpers.ts";

/** Region label printed in reports built from an upload. */
export const RECORDED_REGION = "Recorded in your browser";

export const UPLOAD_LIMITS = {
  /** Body as sent (gzip, or plain JSON when no Content-Encoding). */
  compressedBytes: 2 * 1024 * 1024,
  /** JSON after gunzip. */
  decompressedBytes: 10 * 1024 * 1024,
  requests: 5000,
  postDataBytes: 64 * 1024,
  requestUrl: 8192,
  pageUrl: 2048,
  dataLayerPerRun: 2000,
  cookiesPerRun: 500,
  pages: 200,
  guidedSteps: 100,
  conversionPoints: 50,
  walkSteps: 50,
  errorsPerRun: 20,
  platformHints: 20,
};

/** A problem with the upload: 400 for a bad shape, 413 for a cap. */
export class UploadError extends Error {
  status: 400 | 413;
  code: "invalid_capture" | "payload_too_large";
  constructor(status: 400 | 413, code: "invalid_capture" | "payload_too_large", detail: string) {
    super(detail);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

/** One step the person was guided through while recording. */
export interface GuidedStep {
  /** snake_case funnel step name: view_item, add_to_cart, begin_checkout, form_start, click, ... */
  name: string;
  /** What they did, in words (max 200 chars, redacted). */
  action: string;
  /** False when they skipped it or it was not possible. Skipped steps are listed but never judged. */
  ok: boolean;
  /** Same clock as request `ts` (ms since the recording started). */
  ts: number;
  pageUrl?: string;
  scenario?: Scenario;
  /** Which kind of conversion the step belongs to, when the step name alone is ambiguous. */
  conversionType?: ConversionType;
  /** Id of a ConversionPoint in the capture to attach the step to. */
  pointId?: string;
}

export interface CaptureUpload {
  /** Validated and redacted. Every request and dataLayer entry has a phase. */
  capture: Capture;
  guidedSteps: GuidedStep[];
  consentMarkerTs?: number;
  /** Requests dropped because their URL was not a plain http(s) URL, or too long. */
  droppedRequests: number;
}

/* ------------------------------------------------------------------ */
/* Redaction                                                            */
/* ------------------------------------------------------------------ */

/** The lookbehind keeps this linear: a long run of address characters is scanned once, not once per start. */
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi;
const DIGITS = /\+?\d[\d\s().\-/]{7,}\d/g;

/** Same short non-reversible hash as the INIT_SCRIPT, so equality (a reused transaction_id) still shows. */
function shortHash(s: string): string {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return (x >>> 16).toString(16);
}

export function redactEmails(s: string): string {
  return s.replace(EMAIL, "[email]");
}

/**
 * Free text (labels, actions, titles, dataLayer strings): emails and phone-like digit runs.
 * Input is cut first so a hostile megabyte cannot cost much, and a token cut in half by that
 * cut is dropped, so a truncated email never survives as a readable half.
 */
export function redactFree(input: string, max: number): string {
  const pre = max * 4;
  let s = input;
  if (input.length > pre) {
    // A token holding an @ that the cut left half-written is dropped (its domain is gone, so it is not an email any more).
    s = input.slice(0, pre).replace(/[^\s,;&=?/"'<>]*(?:@|%40)[^\s,;&=?/"'<>@]*$/i, "");
  }
  s = redactEmails(s);
  s = s.replace(DIGITS, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 9 ? `[digits:${shortHash(d)}]` : m;
  });
  return s.length > max ? s.slice(0, max) : s;
}

/** Keys the decoders and rules read (session and page-load counters). Everything else PII-like is hidden. */
const KEEP_KEYS = new Set(["sid", "_s", "_p", "sct", "seg"]);
const PII_WORD = /e-?mail|phone|mobile|passw|token|secret|first_?name|last_?name|full_?name|birth|street|postal|zip_?code|\bssn\b|card_?number|\biban\b/i;
const EXTRA_PII = new Set(["_gl", "uip", "user_ip"]);

/** True when the value under this key identifies a person, browser or session (the key stays, the value goes). */
export function isPiiParam(key: string): boolean {
  const k = key.toLowerCase();
  if (KEEP_KEYS.has(k)) return false;
  const leaf = k.replace(/^(?:ep|epn|up|upn)\./, "");
  if (KEEP_KEYS.has(leaf)) return false;
  return isPiiKey(k) || isPiiKey(leaf) || EXTRA_PII.has(leaf) || PII_WORD.test(k);
}

const R = "[redacted]";

/** Clean a query value: nested URLs (dl, dr, url) are cleaned as URLs (two levels deep), the rest loses emails. */
function cleanValue(v: string, depth: number): string {
  if (depth < 2 && /^https?:\/\//i.test(v)) return cleanUrl(v, UPLOAD_LIMITS.requestUrl, depth + 1) ?? redactEmails(v);
  return redactEmails(v);
}

function cleanParams(p: URLSearchParams, depth: number): URLSearchParams | undefined {
  const next = new URLSearchParams();
  let changed = false;
  for (const [k, v] of p) {
    const nv = isPiiParam(k) ? R : cleanValue(v, depth);
    if (nv !== v) changed = true;
    next.append(k, nv);
  }
  return changed ? next : undefined;
}

/**
 * http(s) URL with credentials and non-route fragments removed, PII-like param values replaced and
 * emails masked. Returns undefined when it is not a plain http(s) URL or is longer than `max`.
 */
export function cleanUrl(raw: string, max: number, depth = 0): string | undefined {
  if (raw.length > max) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  u.username = "";
  u.password = "";
  if (u.search) {
    const next = cleanParams(u.searchParams, depth);
    if (next) u.search = next.toString();
  }
  const path = redactEmails(u.pathname);
  if (path !== u.pathname) u.pathname = path;
  // Only SPA routes (#/page) are kept; other fragments can hold tokens and never reach a server.
  u.hash = u.hash.startsWith("#/") ? redactEmails(u.hash) : "";
  return u.href;
}

function cleanJson(v: unknown, depth: number, key = ""): unknown {
  if (key && isPiiParam(key)) return R;
  if (typeof v === "string") return redactEmails(v);
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (depth >= 8) return "[depth]";
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => cleanJson(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (n++ >= 200) break;
      out[redactEmails(k)] = cleanJson(x, depth + 1, k);
    }
    return out;
  }
  return null;
}

/** Request body: urlencoded lines (GA4 batches, Meta) and JSON are cleaned by key; anything else loses emails. */
export function cleanBody(body: string): string {
  const s = body.length > UPLOAD_LIMITS.postDataBytes ? body.slice(0, UPLOAD_LIMITS.postDataBytes) : body;
  const t = s.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(cleanJson(JSON.parse(s), 0));
    } catch {
      // Cut off at the cap, so not valid JSON: hide sensitive "key": "value" pairs by pattern.
      return redactEmails(
        s.replace(/"([^"\\]{1,60})"\s*:\s*"(?:[^"\\]|\\.)*"/g, (m, k: string) => (isPiiParam(k) ? `"${k}":"${R}"` : m)),
      );
    }
  }
  if (/^[\w.[\]%-]+=/.test(t)) {
    return s
      .split("\n")
      .map((line) => {
        const cr = line.endsWith("\r") ? "\r" : "";
        const raw = cr ? line.slice(0, -1) : line;
        const next = cleanParams(new URLSearchParams(raw), 0);
        return next ? next.toString() + cr : line;
      })
      .join("\n");
  }
  return redactEmails(s);
}

/** dataLayer payload: same bounds as the INIT_SCRIPT (depth 6, 100 keys, 50 items, 2000 chars), keys checked too. */
function cleanPayload(v: unknown, depth: number, key = ""): unknown {
  if (key && isPiiParam(key)) return R;
  if (v === null || v === undefined) return v === null ? null : "[undefined]";
  if (typeof v === "string") return redactFree(v, 2000);
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  if (depth >= 6) return "[depth]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => cleanPayload(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (n++ >= 100) break;
      out[redactFree(k, 100)] = cleanPayload(x, depth + 1, k);
    }
    return out;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                   */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;

function bad(path: string, why: string): never {
  throw new UploadError(400, "invalid_capture", `${path}: ${why}`);
}
function obj(v: unknown, path: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(path, "expected an object");
  return v as Obj;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) bad(path, "expected an array");
  return v as unknown[];
}
/** Absent (undefined or null) is fine for optional fields. */
const absent = (v: unknown) => v === undefined || v === null;
function text(v: unknown, path: string, max: number): string {
  if (typeof v !== "string") bad(path, "expected a string");
  return redactFree(v as string, max);
}
function optText(v: unknown, path: string, max: number): string | undefined {
  return absent(v) ? undefined : text(v, path, max);
}
function num(v: unknown, path: string, min = 0, max = 1e13): number {
  if (typeof v !== "number" || !Number.isFinite(v)) bad(path, "expected a finite number");
  const n = v as number;
  if (n < min || n > max) bad(path, `expected a number between ${min} and ${max}`);
  return n;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") bad(path, "expected true or false");
  return v as boolean;
}
function enumOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) bad(path, `expected one of ${allowed.join(", ")}`);
  return v as T;
}
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
function idOf(v: unknown, path: string): string {
  if (typeof v !== "string" || !ID.test(v)) bad(path, "expected an id of 1-64 letters, digits, . _ : -");
  return v as string;
}

const SCENARIOS = ["none", "accept", "reject"] as const;
const PHASES = ["pre", "post"] as const;
const BANNERS = ["clicked", "no_banner", "not_clickable", "not_applicable", "blocked_by_bot_protection"] as const satisfies readonly BannerOutcome[];
const BLOCKS = ["ssrf", "form_submit", "payment", "unsafe_method", "limit"] as const;
const VIAS = ["start", "link", "spa_route", "funnel"] as const;
const TYPES = ["purchase", "lead", "booking", "signup", "contact_click", "download"] as const satisfies readonly ConversionType[];
const CONSENT_KEYS = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"] as const satisfies readonly ConsentKey[];
const CONSENT_VALUES = ["granted", "denied", "unset", "unknown"] as const satisfies readonly ConsentValue[];

/** A step or event name: lower snake_case, at most 40 chars. Loose input ("Add to cart") is normalised. */
function stepName(v: unknown, path: string): string {
  if (typeof v !== "string") bad(path, "expected a string");
  const n = (v as string).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!n) bad(path, "expected a step name");
  return n;
}

function pageUrlOf(v: unknown, fallback: string, path: string): string {
  if (absent(v)) return fallback;
  if (typeof v !== "string") bad(path, "expected a string");
  let s = v as string;
  if (s.length > UPLOAD_LIMITS.pageUrl) s = s.split(/[?#]/)[0] ?? "";
  return cleanUrl(s, UPLOAD_LIMITS.pageUrl) ?? fallback;
}

/* ------------------------------------------------------------------ */
/* parseCaptureUpload                                                   */
/* ------------------------------------------------------------------ */

export function parseCaptureUpload(raw: unknown): CaptureUpload {
  const body = obj(raw, "body");
  const c = obj(body.capture, "capture");

  const marker = absent(body.consentMarkerTs) ? undefined : num(body.consentMarkerTs, "consentMarkerTs");
  const phaseOf = (given: unknown, ts: number, path: string): ConsentPhase =>
    absent(given) ? (marker !== undefined && ts >= marker ? "post" : "pre") : enumOf(given, PHASES, path);

  const target = cleanUrl(text0(c.target, "capture.target"), UPLOAD_LIMITS.pageUrl);
  if (!target) bad("capture.target", "expected an http(s) URL");
  const finalUrl = pageUrlOf(c.finalUrl, target as string, "capture.finalUrl");
  const startedMs = typeof c.startedAt === "string" ? Date.parse(c.startedAt) : NaN;
  if (!Number.isFinite(startedMs)) bad("capture.startedAt", "expected an ISO date string");
  const durationMs = num(c.durationMs, "capture.durationMs", 0, 7 * 86400_000);
  const userAgent = absent(c.userAgent) ? "" : text(c.userAgent, "capture.userAgent", 300);
  const siteHost = hostOf(finalUrl);

  // The request cap is checked on the raw arrays, before any per-item work.
  const runsRaw = arr(c.scenarios, "capture.scenarios");
  if (runsRaw.length < 1 || runsRaw.length > 3) bad("capture.scenarios", "expected 1 to 3 scenario runs");
  let rawRequests = 0;
  for (const r of runsRaw) {
    const rr = r && typeof r === "object" ? (r as Obj).requests : undefined;
    if (Array.isArray(rr)) rawRequests += rr.length;
  }
  if (rawRequests > UPLOAD_LIMITS.requests) {
    throw new UploadError(413, "payload_too_large", `capture has ${rawRequests} requests, the limit is ${UPLOAD_LIMITS.requests}`);
  }

  const seenScenarios = new Set<Scenario>();
  const seenIds = new Set<string>();
  let nextId = 0;
  let dropped = 0;
  const scenarios: ScenarioRun[] = runsRaw.map((r, i) => {
    const p = `capture.scenarios[${i}]`;
    const o = obj(r, p);
    const scenario = enumOf(o.scenario, SCENARIOS, `${p}.scenario`);
    if (seenScenarios.has(scenario)) bad(`${p}.scenario`, `scenario "${scenario}" appears twice`);
    seenScenarios.add(scenario);

    const requests: CapturedRequest[] = [];
    for (const [j, rq] of (absent(o.requests) ? [] : arr(o.requests, `${p}.requests`)).entries()) {
      const rp = `${p}.requests[${j}]`;
      const ro = obj(rq, rp);
      if (typeof ro.url !== "string") bad(`${rp}.url`, "expected a string");
      const url = cleanUrl(ro.url as string, UPLOAD_LIMITS.requestUrl);
      if (!url) { dropped++; continue; }
      const ts = num(ro.ts, `${rp}.ts`);
      if (!absent(ro.id) && typeof ro.id !== "string") bad(`${rp}.id`, "expected a string");
      // The engine owns ids: a usable, unique one from the upload is kept, anything else is replaced.
      let id = typeof ro.id === "string" && ID.test(ro.id) ? ro.id : "";
      if (!id || seenIds.has(id)) { do id = `u${++nextId}`; while (seenIds.has(id)); }
      seenIds.add(id);
      const req: CapturedRequest = {
        id,
        scenario,
        phase: phaseOf(ro.phase, ts, `${rp}.phase`),
        ts,
        pageUrl: pageUrlOf(ro.pageUrl, finalUrl, `${rp}.pageUrl`),
        url,
        method: absent(ro.method) ? "GET" : text(ro.method, `${rp}.method`, 10).toUpperCase().replace(/[^A-Z]/g, "") || "GET",
        resourceType: absent(ro.resourceType) ? "other" : text(ro.resourceType, `${rp}.resourceType`, 32).toLowerCase().replace(/[^a-z_]/g, "") || "other",
      };
      if (!absent(ro.postData)) {
        if (typeof ro.postData !== "string") bad(`${rp}.postData`, "expected a string");
        if ((ro.postData as string).length > 0) {
          // Bodies only for requests a decoder recognises as tracking: never a form POST to the site itself.
          const withBody = { ...req, postData: cleanBody(ro.postData as string) };
          if (decodeRequest(withBody, siteHost).length > 0) req.postData = withBody.postData;
        }
      }
      if (!absent(ro.blocked)) req.blocked = enumOf(ro.blocked, BLOCKS, `${rp}.blocked`);
      if (!absent(ro.failed)) req.failed = text(ro.failed, `${rp}.failed`, 200);
      requests.push(req);
    }

    const dataLayer: DataLayerPush[] = [];
    for (const [j, d] of (absent(o.dataLayer) ? [] : arr(o.dataLayer, `${p}.dataLayer`)).entries()) {
      if (dataLayer.length >= UPLOAD_LIMITS.dataLayerPerRun) break;
      const dp = `${p}.dataLayer[${j}]`;
      const dobj = obj(d, dp);
      const ts = num(dobj.ts, `${dp}.ts`);
      dataLayer.push({
        scenario,
        phase: phaseOf(dobj.phase, ts, `${dp}.phase`),
        ts,
        pageUrl: pageUrlOf(dobj.pageUrl, finalUrl, `${dp}.pageUrl`),
        payload: cleanPayload(dobj.payload, 0),
      });
    }

    // Cookies carry no timestamp. They are read when recording stops, so after the consent click when
    // there was one. Cookie VALUES are not part of the shape and are never read.
    const cookies: CookieRecord[] = [];
    for (const [j, k] of (absent(o.cookies) ? [] : arr(o.cookies, `${p}.cookies`)).entries()) {
      if (cookies.length >= UPLOAD_LIMITS.cookiesPerRun) break;
      const cp = `${p}.cookies[${j}]`;
      const ko = obj(k, cp);
      cookies.push({
        scenario,
        phase: absent(ko.phase) ? (marker !== undefined ? "post" : "pre") : enumOf(ko.phase, PHASES, `${cp}.phase`),
        name: text(ko.name, `${cp}.name`, 100),
        domain: text(ko.domain, `${cp}.domain`, 255),
        firstParty: absent(ko.firstParty) ? false : bool(ko.firstParty, `${cp}.firstParty`),
      });
    }

    const run: ScenarioRun = {
      scenario,
      banner: absent(o.banner) ? "not_applicable" : enumOf(o.banner, BANNERS, `${p}.banner`),
      requests,
      dataLayer,
      cookies,
      screenshots: [], // none are accepted from the browser
      errors: (absent(o.errors) ? [] : arr(o.errors, `${p}.errors`)).slice(0, UPLOAD_LIMITS.errorsPerRun).map((e, j) => text(e, `${p}.errors[${j}]`, 300)),
    };
    if (!absent(o.cmp)) run.cmp = text(o.cmp, `${p}.cmp`, 80);
    if (!absent(o.bannerMethod)) run.bannerMethod = enumOf(o.bannerMethod, ["autoconsent", "fallback"] as const, `${p}.bannerMethod`);
    if (!absent(o.gtagConsent)) {
      const g = obj(o.gtagConsent, `${p}.gtagConsent`);
      const out: NonNullable<ScenarioRun["gtagConsent"]> = {};
      for (const ph of PHASES) {
        if (absent(g[ph])) continue;
        const inner = obj(g[ph], `${p}.gtagConsent.${ph}`);
        const keys: Partial<Record<ConsentKey, ConsentValue>> = {};
        for (const k of CONSENT_KEYS) if (!absent(inner[k])) keys[k] = enumOf(inner[k], CONSENT_VALUES, `${p}.gtagConsent.${ph}.${k}`);
        out[ph] = keys;
      }
      run.gtagConsent = out;
    }
    return run;
  });

  const pages: PageVisit[] = (absent(c.pages) ? [] : arr(c.pages, "capture.pages")).slice(0, UPLOAD_LIMITS.pages).map((x, i) => {
    const p = `capture.pages[${i}]`;
    const o = obj(x, p);
    const url = pageUrlOf(o.url, "", `${p}.url`);
    if (!url) bad(`${p}.url`, "expected an http(s) URL");
    const page: PageVisit = {
      url,
      status: absent(o.status) ? null : num(o.status, `${p}.status`, 0, 999),
      via: absent(o.via) ? "link" : enumOf(o.via, VIAS, `${p}.via`),
    };
    if (!absent(o.title)) page.title = text(o.title, `${p}.title`, 200);
    return page;
  });

  const conversionPoints: ConversionPoint[] = (absent(c.conversionPoints) ? [] : arr(c.conversionPoints, "capture.conversionPoints"))
    .slice(0, UPLOAD_LIMITS.conversionPoints)
    .map((x, i) => {
      const p = `capture.conversionPoints[${i}]`;
      const o = obj(x, p);
      const pointUrl = pageUrlOf(o.pageUrl, finalUrl, `${p}.pageUrl`);
      const point: ConversionPoint = {
        id: idOf(o.id, `${p}.id`),
        type: enumOf(o.type, TYPES, `${p}.type`),
        pageUrl: pointUrl,
        label: text(o.label, `${p}.label`, 200),
        detectedBy: absent(o.detectedBy) ? "extension" : text(o.detectedBy, `${p}.detectedBy`, 40),
        confidence: absent(o.confidence) ? 1 : num(o.confidence, `${p}.confidence`, 0, 1),
        walk: (absent(o.walk) ? [] : arr(o.walk, `${p}.walk`)).slice(0, UPLOAD_LIMITS.walkSteps).map((s, j) => {
          const sp = `${p}.walk[${j}]`;
          const so = obj(s, sp);
          return {
            name: stepName(so.name, `${sp}.name`),
            action: text(so.action, `${sp}.action`, 200),
            ok: bool(so.ok, `${sp}.ok`),
            pageUrl: pageUrlOf(so.pageUrl, pointUrl, `${sp}.pageUrl`),
            ts: num(so.ts, `${sp}.ts`),
            scenario: enumOf(so.scenario, SCENARIOS, `${sp}.scenario`),
          } satisfies FunnelStep;
        }),
      };
      if (!absent(o.selector)) point.selector = text(o.selector, `${p}.selector`, 300);
      return point;
    });

  const platformHints = (absent(c.platformHints) ? [] : arr(c.platformHints, "capture.platformHints"))
    .slice(0, UPLOAD_LIMITS.platformHints)
    .map((h, i) => text(h, `capture.platformHints[${i}]`, 60));

  const guidedSteps: GuidedStep[] = (absent(body.guidedSteps) ? [] : arr(body.guidedSteps, "guidedSteps"))
    .slice(0, UPLOAD_LIMITS.guidedSteps)
    .map((x, i) => {
      const p = `guidedSteps[${i}]`;
      const o = obj(x, p);
      const name = stepName(o.name, `${p}.name`);
      const step: GuidedStep = {
        name,
        action: absent(o.action) ? name : text(o.action, `${p}.action`, 200),
        ok: absent(o.ok) ? true : bool(o.ok, `${p}.ok`),
        ts: num(o.ts, `${p}.ts`),
      };
      if (!absent(o.pageUrl)) step.pageUrl = pageUrlOf(o.pageUrl, finalUrl, `${p}.pageUrl`);
      if (!absent(o.scenario)) step.scenario = enumOf(o.scenario, SCENARIOS, `${p}.scenario`);
      if (!absent(o.conversionType)) step.conversionType = enumOf(o.conversionType, TYPES, `${p}.conversionType`);
      if (!absent(o.pointId)) step.pointId = idOf(o.pointId, `${p}.pointId`);
      return step;
    });

  const capture: Capture = {
    target: target as string,
    finalUrl,
    region: RECORDED_REGION,
    startedAt: new Date(startedMs).toISOString(),
    durationMs,
    userAgent,
    pages,
    scenarios,
    conversionPoints,
    platformHints,
  };
  const upload: CaptureUpload = { capture, guidedSteps, droppedRequests: dropped };
  if (marker !== undefined) upload.consentMarkerTs = marker;
  return upload;
}

function text0(v: unknown, path: string): string {
  if (typeof v !== "string") bad(path, "expected a string");
  return v as string;
}

/* ------------------------------------------------------------------ */
/* applyUpload                                                          */
/* ------------------------------------------------------------------ */

/** Which conversion type a funnel step belongs to when the upload does not say. Steps not listed are only shown in the report. */
const STEP_TYPE: Record<string, ConversionType> = {
  view_item: "purchase",
  add_to_cart: "purchase",
  begin_checkout: "purchase",
  add_payment_info: "purchase",
  add_shipping_info: "purchase",
  view_cart: "purchase",
  form_start: "lead",
  click: "contact_click",
};

const TYPE_NOUN: Record<ConversionType, string> = {
  purchase: "Shop",
  lead: "Lead form",
  booking: "Booking",
  signup: "Sign-up",
  contact_click: "Contact link",
  download: "Download",
};

/**
 * A recording is one run with a consent click in the middle. The rules were written for hosted scans,
 * where "no choice made yet" is its own run (scenario none). So when the only run is accept or reject,
 * its before-the-click part becomes that "none" run and the rest stays as the accept or reject run.
 * `boundary` is the consent marker, else the first moment of the after part (Infinity when there is none).
 */
function splitConsent(runs: ScenarioRun[], marker?: number): { runs: ScenarioRun[]; boundary?: number } {
  if (runs.length !== 1 || runs[0].scenario === "none") return { runs };
  const r = runs[0];
  const pre = <T extends { phase: ConsentPhase }>(x: T) => x.phase === "pre";
  const post = <T extends { phase: ConsentPhase }>(x: T) => x.phase === "post";
  if (!r.requests.some(pre) && !r.dataLayer.some(pre) && !r.cookies.some(pre)) return { runs };

  const before: ScenarioRun = {
    scenario: "none",
    banner: "not_applicable",
    requests: r.requests.filter(pre).map((x) => ({ ...x, scenario: "none" })),
    dataLayer: r.dataLayer.filter(pre).map((x) => ({ ...x, scenario: "none" })),
    cookies: r.cookies.filter(pre).map((x) => ({ ...x, scenario: "none" })),
    screenshots: [],
    errors: [],
  };
  if (r.cmp) before.cmp = r.cmp;
  if (r.bannerMethod) before.bannerMethod = r.bannerMethod;
  if (r.gtagConsent?.pre) before.gtagConsent = { pre: r.gtagConsent.pre };

  const after: ScenarioRun = {
    ...r,
    requests: r.requests.filter(post),
    dataLayer: r.dataLayer.filter(post),
    cookies: r.cookies.filter(post),
  };
  if (r.gtagConsent?.post) after.gtagConsent = { post: r.gtagConsent.post };
  else delete after.gtagConsent;

  const firstAfter = Math.min(...after.requests.map((x) => x.ts), ...after.dataLayer.map((x) => x.ts));
  return { runs: [before, after], boundary: marker ?? firstAfter };
}

/**
 * Guided steps become FunnelSteps on conversion points:
 *  1. `pointId` names a point in the capture: the step goes there.
 *  2. Else the type is `conversionType`, or taken from the step name (STEP_TYPE: view_item, add_to_cart,
 *     begin_checkout and the other shop steps are purchase; form_start is lead; click is contact_click).
 *     The step goes to the point of that type on the same page, else the only or most confident point of that type.
 *  3. If the capture has no point of that type, one is created per type (id "guided-<type>", detectedBy
 *     "extension", confidence 1) and holds the steps.
 *  4. A step with no type (for example "stop_before_submit") is only listed in the report.
 * Steps marked not ok are attached but never judged by the rules.
 */
export function applyUpload(up: CaptureUpload): { capture: Capture; recording: Recording } {
  const base = up.capture;
  const split = splitConsent(base.scenarios, up.consentMarkerTs);
  const scenarios = split.runs;
  const points: ConversionPoint[] = base.conversionPoints.map((p) => ({ ...p, walk: [...p.walk] }));

  const scenarioAt = (s: GuidedStep): Scenario => {
    if (s.scenario) return s.scenario;
    if (split.boundary !== undefined) return s.ts < split.boundary ? "none" : scenarios[1].scenario;
    return scenarios[0].scenario;
  };

  for (const s of up.guidedSteps) {
    const explicit = s.pointId ? points.find((p) => p.id === s.pointId) : undefined;
    const type = explicit?.type ?? s.conversionType ?? STEP_TYPE[s.name];
    if (!type) continue;
    let point = explicit;
    if (!point) {
      const same = points.filter((p) => p.type === type);
      const here = s.pageUrl ? normUrl(s.pageUrl) : undefined;
      point =
        (here ? same.find((p) => normUrl(p.pageUrl) === here) : undefined) ??
        [...same].sort((a, b) => b.confidence - a.confidence)[0];
    }
    if (!point) {
      point = {
        id: `guided-${type}`,
        type,
        pageUrl: s.pageUrl ?? base.finalUrl,
        label: `${TYPE_NOUN[type]} path (recorded in your browser)`,
        detectedBy: "extension",
        confidence: 1,
        walk: [],
      };
      points.push(point);
    }
    point.walk.push({ name: s.name, action: s.action, ok: s.ok, pageUrl: s.pageUrl ?? point.pageUrl, ts: s.ts, scenario: scenarioAt(s) });
  }
  for (const p of points) p.walk.sort((a, b) => a.ts - b.ts);

  const requests = scenarios.reduce((n, r) => n + r.requests.length, 0);
  const recording: Recording = {
    source: "extension",
    guidedSteps: up.guidedSteps.map((s) => ({ name: s.name, action: s.action, ok: s.ok, ts: s.ts, ...(s.pageUrl ? { pageUrl: s.pageUrl } : {}) })),
    requests,
  };
  if (up.consentMarkerTs !== undefined) recording.consentMarkerTs = up.consentMarkerTs;

  return {
    capture: { ...base, region: RECORDED_REGION, scenarios, conversionPoints: points },
    recording,
  };
}
