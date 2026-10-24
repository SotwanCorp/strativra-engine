/**
 * The scan pipeline: capture -> decode -> rules -> (AI enrichment) -> report
 * HTML + PDF. The worker loads `pipeline` from here (src/worker/main.ts);
 * the CLI can call `createPipeline` with its own options.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCapture, type RunOptions } from "./browser/runner.ts";
import { decodeAll } from "./core/decode/index.ts";
import { assertPublicUrl, normalizeUrl } from "./core/net/ssrf.ts";
import { buildReport, redactForFree } from "./core/report.ts";
import { renderPdf } from "./report/pdf.ts";
import { renderReportHtml } from "./report/render.ts";
import type { Capture, Report, ReportKind } from "./types.ts";
import type { Pipeline } from "./worker/pipeline.ts";
import { enrichReport } from "./ai/enrich.ts";
import { DailyBreaker } from "./ai/budget.ts";

/** Optional AI step. Receives the deterministic report and must return a report (or the same one). */
export type Enricher = (report: Report, capture: Capture, kind: ReportKind) => Promise<Report>;

export interface PipelineOptions {
  kind?: ReportKind;
  bookUrl?: string;
  pdf?: boolean;
  enrich?: Enricher;
  run?: Partial<RunOptions>;
}

export interface ScanOutput {
  capture: Capture;
  report: Report;
  html: string;
  pdf?: Buffer;
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

/** Screenshots referenced by evidence, embedded as data: URIs (the report CSP allows data: images only). */
async function inlineScreenshots(report: Report, dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of report.findings) {
    for (const ev of f.evidence) {
      if (ev.kind !== "screenshot" || !ev.ref || out[ev.ref]) continue;
      if (!/^[\w.-]+\.(jpe?g|png)$/i.test(ev.ref)) continue;
      try {
        const buf = await readFile(path.join(dir, ev.ref));
        const mime = /\.png$/i.test(ev.ref) ? "image/png" : "image/jpeg";
        out[ev.ref] = `data:${mime};base64,${buf.toString("base64")}`;
      } catch {
        // Missing file: the renderer shows a placeholder.
      }
    }
  }
  return out;
}

export async function scan(
  url: URL,
  o: { region: string; reportId: string; screenshotDir: string } & PipelineOptions,
): Promise<ScanOutput> {
  const kind = o.kind ?? "free";
  const capture = await runCapture(url.href, { ...o.run, region: o.region, screenshotDir: o.screenshotDir });
  const siteHost = hostOf(capture.finalUrl || capture.target);
  const hits = decodeAll(capture.scenarios.flatMap((s) => s.requests), siteHost);
  let report = buildReport(capture, hits, kind, o.reportId);
  if (o.enrich) {
    try {
      report = await o.enrich(report, capture, kind);
    } catch {
      // AI is an enhancement: the deterministic report always ships.
    }
  }
  if (!report.plan) {
    // Deterministic plan (no AI) so the "What your site should track" section always renders.
    try {
      report = (await enrichReport(report, capture, { hits }, kind)).report;
    } catch {
      // The report ships without a plan rather than failing.
    }
  }
  const shown = kind === "free" ? redactForFree(report) : report;
  const inlineAssets = await inlineScreenshots(shown, o.screenshotDir);
  const html = renderReportHtml(shown, { kind, bookUrl: o.bookUrl ?? process.env.BOOK_URL ?? "https://strativra.com/audit", inlineAssets });
  const pdf = o.pdf === false ? undefined : await renderPdf(html).catch(() => undefined);
  return { capture, report: shown, html, pdf };
}

export function createPipeline(opts: PipelineOptions = {}): Pipeline {
  return {
    // Sandbox only (SCAN_UPSTREAM_PROXY set, no local DNS): hostname checks only, as in src/cli/scan.ts.
    // The runner's network guard still checks every request and redirect. Production resolves DNS here.
    validateUrl: async (input: string) => (opts.run?.upstreamProxy ? normalizeUrl(input) : assertPublicUrl(input)),
    run: async (url, o) => {
      const { report, html, pdf } = await scan(url, { ...opts, ...o });
      return { report, html, pdf };
    },
  };
}

/**
 * AI enrichment when keys are configured (TYPESAFE_API_KEY for Jev, ANTHROPIC_API_KEY for Claude).
 * Either one alone works; with neither, reports stay deterministic.
 */
export async function aiEnricherFromEnv(): Promise<Enricher | undefined> {
  const hasJev = !!process.env.TYPESAFE_API_KEY;
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;
  if (!hasJev && !hasClaude) return undefined;
  const jev = hasJev ? new (await import("@typesafe-ai/sdk")).TypeSafeClient() : undefined;
  const claude = hasClaude ? new (await import("@anthropic-ai/sdk")).default() : undefined;
  const breaker = new DailyBreaker({ maxUsdPerDay: Number(process.env.AI_DAILY_MAX_USD ?? 5) });
  return async (report, capture, kind) => {
    const hits = decodeAll(capture.scenarios.flatMap((s) => s.requests), hostOf(capture.finalUrl || capture.target));
    const res = await enrichReport(report, capture, { jev, claude, breaker, hits }, kind);
    return res.report;
  };
}

/** Sandbox-only egress settings (cloud dev sessions): never set in production. */
function sandboxRun(): Partial<RunOptions> {
  const upstream = process.env.SCAN_UPSTREAM_PROXY;
  return upstream ? { upstreamProxy: upstream, dnsFailure: "allow" } : {};
}

/**
 * Browser budget for one scan (all three consent scenarios, walks and sub-pages). 120 s was too
 * short for sites with a consent banner and several conversion paths. Keep it about 60 s under the
 * worker's JOB_TIMEOUT_MS (default 240 s), which also covers the report, AI and PDF.
 */
export function scanTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.SCAN_TIMEOUT_MS ?? 180_000);
  return Number.isFinite(v) && v >= 30_000 ? v : 180_000;
}

export const pipeline: Pipeline = createPipeline({ run: { ...sandboxRun(), timeoutMs: scanTimeoutMs() }, enrich: await aiEnricherFromEnv() });
