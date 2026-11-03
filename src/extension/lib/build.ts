/**
 * Recording -> Capture (src/types.ts) + the upload envelope POST /api/v1/captures takes
 * ({capture, guidedSteps, consentMarkerTs, clientVersion}, CONNECTORS.md 4.1; plus `visitor`).
 *
 * One recording is one ScenarioRun:
 *  - scenario = the consent choice ("accept" / "reject" from the marker), "none" without a marker
 *  - phase = "pre" before the marker, "post" from it on (ts >= marker, the engine's rule)
 *  - ts = ms since the recording started, for requests, dataLayer pushes, guided steps and the marker
 * The engine (src/core/upload.ts applyUpload) splits an accept/reject run into "none" + the choice
 * and maps guided steps onto conversion points, so conversionPoints stay empty here.
 * Pure: no chrome.*, no I/O. Redaction happens next (prepare.ts), before anything is shown or sent.
 */
import { icsToConsent } from "../../browser/init-script.ts";
import { RECORDED_REGION, type GuidedStep } from "../../core/upload.ts";
import type { Capture, CapturedRequest, ConsentPhase, CookieRecord, DataLayerPush, PageVisit, Scenario, ScenarioRun } from "../../types.ts";
import {
  isFirstPartyDomain, mapResourceType,
  type Marker, type RawCookies, type RawError, type RawIcs, type RawNav, type RawPush, type RawRequest, type StepRecord, type Visitor,
} from "./record.ts";

export interface RecordingInput {
  target: string;
  startedAt: number;
  stoppedAt: number;
  userAgent: string;
  visitor: Visitor;
  marker?: Marker | null;
  requests: RawRequest[];
  errors: RawError[];
  dataLayer: RawPush[];
  ics: RawIcs[];
  droppedPushes: number;
  navs: RawNav[];
  clicks: number[];
  cookies: RawCookies[];
  steps: StepRecord[];
  clientVersion: string;
}

export interface UploadEnvelope {
  capture: Capture;
  guidedSteps: GuidedStep[];
  /** ms since the recording started; absent when no consent choice was made. */
  consentMarkerTs?: number;
  clientVersion: string;
  /** "fresh" (site data cleared before the reload) or "returning" (recorded as is). */
  visitor: Visitor;
}

export function phaseAt(ts: number, marker: number | undefined): ConsentPhase {
  return marker !== undefined && ts >= marker ? "post" : "pre";
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

const byTs = <T>(key: (x: T) => number) => (a: T, b: T) => key(a) - key(b);

/** Top-level URL at time `ts` (last navigation at or before it). */
function urlAt(navs: RawNav[], ts: number, fallback: string): string {
  let url = fallback;
  for (const n of navs) {
    if (n.ts > ts) break;
    url = n.url;
  }
  return url;
}

/** The moment a guided step happened: the last page load / click since the previous step, else the press. */
export function resolveStepTs(step: StepRecord, prevTs: number, clicks: number[], navs: RawNav[]): number {
  const inWindow = (t: number) => t > prevTs && t <= step.doneTs;
  const lastOf = (xs: number[]) => xs.filter(inWindow).reduce((m, t) => (t > m ? t : m), -Infinity);
  const navTs = navs.map((n) => n.ts);
  let t = -Infinity;
  if (step.at === "page_load") t = lastOf(navTs) > -Infinity ? lastOf(navTs) : lastOf(clicks);
  else if (step.at === "click") t = lastOf(clicks);
  else if (step.at === "any") t = Math.max(lastOf(clicks), lastOf(navTs));
  return Number.isFinite(t) ? t : step.doneTs;
}

export function visitorStep(visitor: Visitor, pageUrl: string): GuidedStep {
  return visitor === "fresh"
    ? { name: "fresh_visitor", action: "Started as a fresh visitor: site cookies and storage cleared, page reloaded", ok: true, ts: 0, pageUrl }
    : { name: "returning_visitor", action: "Started as a returning visitor: cookies, logins and saved choices kept", ok: true, ts: 0, pageUrl };
}

export function buildCapture(input: RecordingInput): UploadEnvelope {
  const t0 = input.startedAt;
  const rel = (ts: number) => Math.max(0, Math.round(ts - t0));
  const marker = input.marker ?? undefined;
  const markerRel = marker ? rel(marker.ts) : undefined;
  const scenario: Scenario = marker ? marker.choice : "none";

  const navs = [...input.navs].filter((n) => n.ts >= t0 - 1).sort(byTs((n: RawNav) => n.ts));
  const finalUrl = navs.find((n) => n.kind === "commit")?.url ?? input.target;
  const siteHost = hostOf(finalUrl);

  /* requests: one entry per hop; a failure belongs to the last hop of its request id */
  const raw = [...input.requests].sort(byTs((r: RawRequest) => r.ts));
  const lastHop = new Map<string, number>();
  raw.forEach((r, i) => lastHop.set(r.rid, i));
  const failed = new Map<number, string>();
  for (const e of input.errors) {
    const i = lastHop.get(e.rid);
    if (i !== undefined) failed.set(i, e.error);
  }
  const requests: CapturedRequest[] = raw.map((r, i) => {
    const ts = rel(r.ts);
    const out: CapturedRequest = {
      id: `${scenario}-${i + 1}`,
      scenario,
      phase: phaseAt(ts, markerRel),
      ts,
      pageUrl: r.pageUrl || urlAt(navs, r.ts, finalUrl),
      url: r.url,
      method: (r.method || "GET").toUpperCase(),
      resourceType: mapResourceType(r.type),
    };
    if (r.body !== undefined && r.body !== "") out.postData = r.body;
    const f = failed.get(i);
    if (f) out.failed = f;
    return out;
  });

  /* dataLayer pushes, already PII-redacted in the page by INIT_SCRIPT */
  const dataLayer: DataLayerPush[] = [...input.dataLayer].sort(byTs((d: RawPush) => d.t)).map((d) => {
    const ts = rel(d.t);
    return { scenario, phase: phaseAt(ts, markerRel), ts, pageUrl: d.pageUrl || urlAt(navs, d.t, finalUrl), payload: d.p };
  });

  /* cookies: names and domains only, the last snapshot before the choice (pre) and the final one */
  const snaps = [...input.cookies].sort(byTs((c: RawCookies) => c.ts));
  const final = snaps[snaps.length - 1];
  const cookies: CookieRecord[] = [];
  const addSnap = (s: RawCookies | undefined, phase: ConsentPhase) => {
    if (!s) return;
    const seen = new Set<string>();
    for (const c of s.list) {
      const domain = c.domain.replace(/^\./, "").toLowerCase();
      const k = `${c.name}|${domain}`;
      if (seen.has(k)) continue;
      seen.add(k);
      cookies.push({ scenario, phase, name: c.name, domain, firstParty: isFirstPartyDomain(domain, siteHost) });
    }
  };
  if (marker) {
    const pre = [...snaps].reverse().find((s) => s.ts < marker.ts);
    addSnap(pre, "pre");
    if (final && final.ts >= marker.ts) addSnap(final, "post");
  } else {
    addSnap(final, "pre");
  }

  /* live gtag consent state (google_tag_data.ics), per phase */
  const icsSorted = [...input.ics].filter((x) => x.ics).sort(byTs((x: RawIcs) => x.t));
  const lastIcs = (pred: (x: RawIcs) => boolean) => [...icsSorted].reverse().find(pred);
  const gtagConsent: NonNullable<ScenarioRun["gtagConsent"]> = {};
  const preIcs = marker ? lastIcs((x) => x.t < marker.ts) : lastIcs(() => true);
  const preC = icsToConsent(preIcs?.ics ?? null);
  if (preC) gtagConsent.pre = preC;
  if (marker) {
    const postC = icsToConsent(lastIcs((x) => x.t >= marker.ts)?.ics ?? null);
    if (postC) gtagConsent.post = postC;
  }

  const errors: string[] = [];
  if (input.droppedPushes > 0) errors.push(`dataLayer: ${input.droppedPushes} pushes over the cap were not recorded`);

  const run: ScenarioRun = {
    scenario,
    banner: marker ? "clicked" : "not_applicable",
    requests,
    dataLayer,
    cookies,
    screenshots: [],
    errors,
  };
  if (gtagConsent.pre || gtagConsent.post) run.gtagConsent = gtagConsent;

  /* pages: top-level navigations, in order */
  const pages: PageVisit[] = [];
  const seenPages = new Set<string>();
  navs.forEach((n, i) => {
    if (seenPages.has(n.url)) return;
    seenPages.add(n.url);
    pages.push({ url: n.url, status: n.status ?? null, via: i === 0 ? "start" : n.kind === "spa" ? "spa_route" : "link" });
  });

  /* guided steps: the visitor choice, then the template steps as done, skipped or stopped */
  const guidedSteps: GuidedStep[] = [visitorStep(input.visitor, finalUrl)];
  let prev = t0;
  for (const s of [...input.steps].sort(byTs((x: StepRecord) => x.doneTs))) {
    const at = s.status === "done" ? resolveStepTs(s, prev, input.clicks, navs) : s.doneTs;
    const step: GuidedStep = {
      name: s.name,
      action: s.status === "skipped" ? `Skipped: ${s.action}` : s.action,
      ok: s.status !== "skipped",
      ts: rel(at),
      pageUrl: urlAt(navs, at, finalUrl),
    };
    if (s.conversionType && s.status !== "stopped") step.conversionType = s.conversionType;
    guidedSteps.push(step);
    prev = s.doneTs;
  }

  const capture: Capture = {
    target: input.target,
    finalUrl,
    region: RECORDED_REGION,
    startedAt: new Date(t0).toISOString(),
    durationMs: Math.max(0, Math.round(input.stoppedAt - t0)),
    userAgent: input.userAgent,
    pages,
    scenarios: [run],
    conversionPoints: [],
    platformHints: [],
  };
  const env: UploadEnvelope = { capture, guidedSteps, clientVersion: input.clientVersion, visitor: input.visitor };
  if (markerRel !== undefined) env.consentMarkerTs = markerRel;
  return env;
}
