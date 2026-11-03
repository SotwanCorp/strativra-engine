import { createHmac } from "node:crypto";
import type { ContractStatus, ConversionType, Severity } from "../types.ts";
import type { Source, Trigger } from "./queue.ts";

/** What the platform shows next to a finished scan without opening the report. */
export interface WebhookSummary {
  counts: Record<Severity, number>;
  /** The top 3 open findings, in report order. */
  top: Array<{ id: string; title: string; severity: Severity }>;
  conversions: Array<{ type: ConversionType; status: ContractStatus }>;
  /** Present when the scan could not run (bot protection, unreachable, ...). */
  aborted?: { reason: string; detail: string };
}

export interface WebhookPayload {
  event: "scan.done" | "scan.failed";
  jobId: string;
  reportId: string;
  url: string;
  /** Where the job came from. Jobs created without these fields are "website" / "manual". */
  source: Source;
  trigger: Trigger;
  /** Opaque platform refs, echoed back as sent. */
  accountRef?: string;
  siteRef?: string;
  /** Whether AI enrichment was allowed for this job. */
  ai: boolean;
  /** Only on scan.done. */
  summary?: WebhookSummary;
  /** Raw email, handed back to the site's lead store + mailer. Never logged here. */
  email?: string;
  /** Private report token (only on scan.done). The site emails reportBaseUrl/r/<token>. */
  token?: string;
  reportUrl?: string;
  error?: string;
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

/** Summary of a finished report. The report comes from the injected pipeline, so it is read defensively. */
export function summarizeReport(report: unknown): WebhookSummary | undefined {
  if (!report || typeof report !== "object") return undefined;
  const r = report as Record<string, unknown>;
  if (!r.counts || typeof r.counts !== "object" || !Array.isArray(r.findings)) return undefined;
  const c = r.counts as Record<string, unknown>;
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, typeof c[s] === "number" ? c[s] : 0])) as Record<Severity, number>;
  const findings = r.findings as Array<{ id?: unknown; title?: unknown; severity?: unknown }>;
  const open = Array.isArray(r.open) ? (r.open as unknown[]) : [];
  const top: WebhookSummary["top"] = [];
  for (const id of open) {
    const f = findings.find((x) => x && x.id === id);
    if (f && typeof f.id === "string" && typeof f.title === "string" && SEVERITIES.includes(f.severity as Severity)) {
      top.push({ id: f.id, title: f.title, severity: f.severity as Severity });
    }
    if (top.length === 3) break;
  }
  const conversions = (Array.isArray(r.conversions) ? (r.conversions as Array<{ type?: unknown; status?: unknown }>) : [])
    .filter((x) => x && typeof x.type === "string" && typeof x.status === "string")
    .map((x) => ({ type: x.type as ConversionType, status: x.status as ContractStatus }));
  const summary: WebhookSummary = { counts, top, conversions };
  const aborted = (r.scan as { aborted?: { reason?: unknown; detail?: unknown } } | undefined)?.aborted;
  if (aborted && typeof aborted.reason === "string") summary.aborted = { reason: aborted.reason, detail: String(aborted.detail ?? "").slice(0, 200) };
  return summary;
}

export function signBody(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export interface WebhookOptions {
  url?: string;
  secret: string;
  fetch?: typeof fetch;
  retries?: number;
  backoffMs?: number;
  log?: (msg: string) => void;
}

/** POST the signed payload. Headers: X-Strativra-Timestamp, X-Strativra-Signature = sha256=HMAC(secret, `${ts}.${body}`). */
export async function sendWebhook(payload: WebhookPayload, o: WebhookOptions): Promise<boolean> {
  if (!o.url) return false;
  const body = JSON.stringify(payload);
  const retries = o.retries ?? 3;
  for (let i = 0; i < retries; i++) {
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await (o.fetch ?? fetch)(o.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-strativra-timestamp": ts,
          "x-strativra-signature": signBody(o.secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
    } catch { /* retry */ }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, (o.backoffMs ?? 2000) * 2 ** i));
  }
  o.log?.(`webhook delivery failed for job ${payload.jobId}`);
  return false;
}
