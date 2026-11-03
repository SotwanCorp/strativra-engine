/**
 * Upload preparation: caps, client-side redaction, the review summary, host removal and gzip.
 *
 * Redaction is the engine's own: `parseCaptureUpload` (src/core/upload.ts) validates the shape,
 * masks emails, replaces PII-like param values, keeps bodies only for requests a decoder recognises
 * and bounds every string. The engine runs it again on receipt; running it here first means the
 * review screen shows exactly what will leave the browser, and that a valid upload is never refused.
 *
 * Caps (CONNECTORS.md 4.1): 5,000 requests, 64 KB per body, 2 MB gzipped.
 */
import { isTrackingUrl, registrableDomain } from "../../browser/capture.ts";
import { decodeRequest } from "../../core/decode/index.ts";
import { parseCaptureUpload } from "../../core/upload.ts";
import type { CapturedRequest, Scenario, ScenarioRun } from "../../types.ts";
import { BODY_CAP, capUtf8 } from "./body.ts";
import type { UploadEnvelope } from "./build.ts";

export const CAPS = {
  gzBytes: 2 * 1024 * 1024,
  requests: 5000,
  bodyBytes: BODY_CAP,
};

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

function siteHostOf(env: UploadEnvelope): string {
  return hostOf(env.capture.finalUrl || env.capture.target);
}

function isTracking(r: CapturedRequest, siteHost: string): boolean {
  return isTrackingUrl(r.url) || decodeRequest(r, siteHost).length > 0;
}

function mapRuns(env: UploadEnvelope, fn: (run: ScenarioRun) => ScenarioRun): UploadEnvelope {
  return { ...env, capture: { ...env.capture, scenarios: env.capture.scenarios.map(fn) } };
}

function note(run: ScenarioRun, text: string): ScenarioRun {
  return { ...run, errors: [...run.errors, text] };
}

/**
 * At most `max` requests. Tracking requests are kept first, then navigations, then the rest in
 * time order; the dropped count is noted on the run.
 */
export function enforceRequestCap(env: UploadEnvelope, max = CAPS.requests): { env: UploadEnvelope; dropped: number } {
  const total = env.capture.scenarios.reduce((n, r) => n + r.requests.length, 0);
  if (total <= max) return { env, dropped: 0 };
  const siteHost = siteHostOf(env);
  const all = env.capture.scenarios.flatMap((run, ri) => run.requests.map((r, i) => ({ r, ri, i })));
  const rank = (r: CapturedRequest) => (isTracking(r, siteHost) ? 0 : r.resourceType === "document" || r.resourceType === "sub_frame" ? 1 : 2);
  const keep = new Set(
    all
      .map((x) => ({ ...x, k: rank(x.r) }))
      .sort((a, b) => a.k - b.k || a.r.ts - b.r.ts)
      .slice(0, max)
      .map((x) => `${x.ri}:${x.i}`),
  );
  const dropped = total - keep.size;
  const scenarios = env.capture.scenarios.map((run, ri) => {
    const next = { ...run, requests: run.requests.filter((_, i) => keep.has(`${ri}:${i}`)) };
    return ri === 0 ? note(next, `${dropped} requests over the ${max} request cap were left out (tracking requests kept)`) : next;
  });
  return { env: { ...env, capture: { ...env.capture, scenarios } }, dropped };
}

/** Bodies cut to 64 KB of UTF-8 (the platform counts bytes). */
export function capBodies(env: UploadEnvelope, maxBytes = CAPS.bodyBytes): UploadEnvelope {
  return mapRuns(env, (run) => ({
    ...run,
    requests: run.requests.map((r) => (r.postData === undefined ? r : { ...r, postData: capUtf8(r.postData, maxBytes) })),
  }));
}

/** Request cap, then the engine's validation and redaction, then the body cap. Throws UploadError on a bad shape. */
export function redactForUpload(env: UploadEnvelope): UploadEnvelope {
  const capped = enforceRequestCap(env).env;
  const up = parseCaptureUpload({ capture: capped.capture, guidedSteps: capped.guidedSteps, consentMarkerTs: capped.consentMarkerTs });
  const out: UploadEnvelope = { capture: up.capture, guidedSteps: up.guidedSteps, clientVersion: env.clientVersion, visitor: env.visitor };
  if (up.consentMarkerTs !== undefined) out.consentMarkerTs = up.consentMarkerTs;
  return capBodies(out);
}

/** The review screen's "remove": every request to that exact host is left out. */
export function removeHost(env: UploadEnvelope, host: string): UploadEnvelope {
  const h = host.toLowerCase();
  return mapRuns(env, (run) => ({ ...run, requests: run.requests.filter((r) => hostOf(r.url).toLowerCase() !== h) }));
}

export interface HostRow {
  host: string;
  requests: number;
  tracking: number;
  vendors: string[];
  firstParty: boolean;
}

export interface ReviewSummary {
  scenario: Scenario;
  requests: number;
  tracking: number;
  dataLayer: number;
  cookies: number;
  pages: number;
  steps: number;
  vendors: Record<string, number>;
  hosts: HostRow[];
}

/** Counts and hosts for the review screen (tracking hosts first, then by request count). */
export function summarize(env: UploadEnvelope): ReviewSummary {
  const siteHost = siteHostOf(env);
  const site = registrableDomain(siteHost);
  const hosts = new Map<string, HostRow>();
  const vendors: Record<string, number> = {};
  let requests = 0;
  let tracking = 0;
  let dataLayer = 0;
  let cookies = 0;
  for (const run of env.capture.scenarios) {
    dataLayer += run.dataLayer.length;
    cookies += new Set(run.cookies.map((c) => `${c.name}|${c.domain}`)).size;
    for (const r of run.requests) {
      requests++;
      const host = hostOf(r.url).toLowerCase();
      const row = hosts.get(host) ?? { host, requests: 0, tracking: 0, vendors: [], firstParty: registrableDomain(host) === site };
      row.requests++;
      const hits = decodeRequest(r, siteHost);
      if (hits.length || isTrackingUrl(r.url)) {
        row.tracking++;
        tracking++;
      }
      for (const h of hits) {
        vendors[h.vendor] = (vendors[h.vendor] ?? 0) + 1;
        if (!row.vendors.includes(h.vendor)) row.vendors.push(h.vendor);
      }
      hosts.set(host, row);
    }
  }
  return {
    scenario: env.capture.scenarios[env.capture.scenarios.length - 1]?.scenario ?? "none",
    requests,
    tracking,
    dataLayer,
    cookies,
    pages: env.capture.pages.length,
    steps: env.guidedSteps.length,
    vendors,
    hosts: [...hosts.values()].sort((a, b) => b.tracking - a.tracking || b.requests - a.requests || a.host.localeCompare(b.host)),
  };
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class PackError extends Error {
  code: "too_large";
  constructor(detail: string) {
    super(detail);
    this.name = "PackError";
    this.code = "too_large";
  }
}

/** Reductions tried in order when the gzipped JSON is over the cap. */
const REDUCERS: Array<{ label: string; run: (env: UploadEnvelope) => UploadEnvelope }> = [
  {
    label: "non-tracking requests other than page loads were left out to fit the 2 MB upload cap",
    run: (env) => {
      const siteHost = siteHostOf(env);
      return mapRuns(env, (run) => ({ ...run, requests: run.requests.filter((r) => isTracking(r, siteHost) || r.resourceType === "document" || r.resourceType === "sub_frame") }));
    },
  },
  {
    label: "dataLayer pushes after the first 300 were left out to fit the 2 MB upload cap",
    run: (env) => mapRuns(env, (run) => ({ ...run, dataLayer: run.dataLayer.slice(0, 300) })),
  },
  {
    label: "request bodies were cut to 8 KB to fit the 2 MB upload cap",
    run: (env) => capBodies(env, 8 * 1024),
  },
];

export interface Packed {
  gz: Uint8Array;
  rawBytes: number;
  env: UploadEnvelope;
  reductions: string[];
}

/** JSON + gzip under the cap, reducing only as much as needed. Throws PackError when it cannot fit. */
export async function packForUpload(env: UploadEnvelope, maxGz = CAPS.gzBytes): Promise<Packed> {
  const enc = new TextEncoder();
  let cur = env;
  const reductions: string[] = [];
  for (let i = 0; ; i++) {
    const json = enc.encode(JSON.stringify(cur));
    const gz = await gzip(json);
    if (gz.byteLength <= maxGz) return { gz, rawBytes: json.byteLength, env: cur, reductions };
    const next = REDUCERS[i];
    if (!next) throw new PackError(`The recording is ${Math.ceil(gz.byteLength / 1024)} KB compressed, over the ${Math.round(maxGz / 1024)} KB cap.`);
    const reduced = next.run(cur);
    cur = { ...reduced, capture: { ...reduced.capture, scenarios: reduced.capture.scenarios.map((run, ri) => (ri === 0 ? note(run, next.label) : run)) } };
    reductions.push(next.label);
  }
}
