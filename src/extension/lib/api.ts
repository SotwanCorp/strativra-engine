/**
 * strativra-api/v1 client (CONNECTORS.md 4.1): API key as a Bearer token, problem+json errors.
 * Used by the side panel (Mode A, polling) and the service worker (upload). The key is never logged
 * and never put in a URL; requests omit cookies.
 */

export const DEFAULT_BASE = "https://strativra.com";
export const DEV_BASE = "http://127.0.0.1:8890";

/**
 * The only servers the key may be sent to: strativra.com (and its subdomains) over https, or a local
 * development copy on 127.0.0.1 / localhost. Returns the origin, or null when not allowed.
 */
export function normalizeBaseUrl(input: string | undefined | null): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return DEFAULT_BASE;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  const host = u.hostname.toLowerCase();
  if (u.protocol === "https:" && (host === "strativra.com" || host.endsWith(".strativra.com"))) return u.origin;
  if (u.protocol === "http:" && (host === "127.0.0.1" || host === "localhost")) return u.origin;
  return null;
}

export type ScanStatus = "queued" | "running" | "done" | "failed";

export interface ScanObject {
  id: string;
  url?: string;
  site_id?: string | number | null;
  source?: string;
  trigger?: string;
  status: ScanStatus;
  position?: number | null;
  created_at?: string;
  finished_at?: string | null;
  summary?: { aborted?: string | { reason?: string } | null; [k: string]: unknown } | null;
  report_url?: string | null;
}

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(status: number, code: string, detail: string, retryAfter?: number) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

const STATUS_CODES: Record<number, string> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  413: "payload_too_large",
  422: "invalid_url",
  429: "rate_limited",
  502: "engine_unavailable",
  503: "engine_unavailable",
};

export interface ApiOptions {
  base: string;
  key: string;
  fetch?: typeof fetch;
}

function retryAfterSeconds(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, Math.round((d - Date.now()) / 1000)) : undefined;
}

async function call<T>(o: ApiOptions, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<T> {
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${o.base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${o.key}`, Accept: "application/json", ...headers },
      body,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new ApiError(0, "network", "network error");
  }
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const p = (json ?? {}) as { code?: unknown; detail?: unknown; title?: unknown };
    const code = typeof p.code === "string" && /^[a-z_]{2,40}$/.test(p.code) ? p.code : STATUS_CODES[res.status] ?? "error";
    const detail = typeof p.detail === "string" ? p.detail : typeof p.title === "string" ? p.title : `HTTP ${res.status}`;
    throw new ApiError(res.status, code, detail, retryAfterSeconds(res.headers.get("retry-after")));
  }
  return json as T;
}

function scanOf(v: unknown): ScanObject {
  const s = v as ScanObject | null;
  if (!s || typeof s !== "object" || typeof s.id !== "string" || typeof s.status !== "string") throw new ApiError(500, "error", "unexpected response");
  return s;
}

export async function createScan(o: ApiOptions, url: string): Promise<ScanObject> {
  const body = JSON.stringify({ url });
  return scanOf(await call(o, "POST", "/scans", body, { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }));
}

export async function getScan(o: ApiOptions, id: string): Promise<ScanObject> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ApiError(400, "not_found", "bad scan id");
  return scanOf(await call(o, "GET", `/scans/${id}`));
}

/** POST /captures: gzipped JSON envelope. 202 + scan object (source extension, trigger upload). */
export async function uploadCapture(o: ApiOptions, gz: Uint8Array): Promise<ScanObject> {
  const headers = { "Content-Type": "application/json", "Content-Encoding": "gzip", "Idempotency-Key": crypto.randomUUID() };
  return scanOf(await call(o, "POST", "/captures", new Blob([gz as BlobPart], { type: "application/json" }), headers));
}

export interface ScanState {
  finished: boolean;
  ok: boolean;
  reportUrl?: string;
  botProtection: boolean;
}

export function abortedReason(s: ScanObject): string | undefined {
  const a = s.summary?.aborted;
  if (typeof a === "string") return a;
  if (a && typeof a === "object" && typeof a.reason === "string") return a.reason;
  return undefined;
}

/** Only http(s) report links are opened. */
export function safeReportUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : undefined;
  } catch {
    return undefined;
  }
}

export function scanState(s: ScanObject): ScanState {
  const finished = s.status === "done" || s.status === "failed";
  return {
    finished,
    ok: s.status === "done",
    reportUrl: s.status === "done" ? safeReportUrl(s.report_url) : undefined,
    botProtection: abortedReason(s) === "bot_protection",
  };
}

/** 2 s, easing to 10 s; Retry-After wins when longer. */
export function pollDelay(attempt: number, retryAfter?: number): number {
  const steps = [2000, 2000, 3000, 3000, 5000, 8000, 10000];
  const base = steps[Math.min(attempt, steps.length - 1)];
  return retryAfter !== undefined ? Math.max(base, retryAfter * 1000) : base;
}

export interface PollOptions {
  onUpdate?: (s: ScanObject) => void;
  signal?: AbortSignal;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll GET /scans/{id} until done or failed. Transient errors (network, 429, 5xx) are retried. */
export async function pollScan(o: ApiOptions, id: string, p: PollOptions = {}): Promise<ScanObject> {
  const sleep = p.sleep ?? wait;
  const until = Date.now() + (p.maxMs ?? 15 * 60_000);
  for (let attempt = 0; ; attempt++) {
    if (p.signal?.aborted) throw new ApiError(0, "aborted", "aborted");
    let retryAfter: number | undefined;
    try {
      const s = await getScan(o, id);
      p.onUpdate?.(s);
      if (s.status === "done" || s.status === "failed") return s;
    } catch (e) {
      const err = e as ApiError;
      const transient = err.status === 0 || err.status === 429 || err.status >= 500;
      if (!transient || err.code === "aborted") throw err;
      retryAfter = err.retryAfter;
    }
    if (Date.now() > until) throw new ApiError(0, "timeout", "the scan took too long");
    await sleep(pollDelay(attempt, retryAfter));
  }
}
