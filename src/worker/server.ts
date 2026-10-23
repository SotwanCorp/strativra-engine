import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { hmacHash, registrableDomain, sealEmail, sha256Hex, TOKEN_RE } from "./crypto.ts";
import type { WorkerConfig } from "./config.ts";
import type { Limits } from "./limits.ts";
import type { Pipeline } from "./pipeline.ts";
import type { JobQueue } from "./queue.ts";
import type { Storage } from "./storage.ts";

export interface ServerDeps {
  config: Pick<WorkerConfig, "secret" | "siteOrigin" | "trustProxy" | "apiKey">;
  queue: JobQueue;
  limits: Limits;
  storage: Storage;
  pipeline: Pick<Pipeline, "validateUrl">;
  /** Returns true when the Turnstile token is valid. */
  verifyTurnstile: (token: string | undefined, ip: string | undefined) => Promise<boolean>;
  log?: (msg: string) => void;
}

const MAX_BODY = 4096;
const EMAIL_RE = /^[^\s@<>()[\],;:"\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

function reportCsp(html: string): string {
  // Allow only the report's own inline scripts, by hash. No external scripts, no network.
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.push(`'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  }
  return [
    "default-src 'none'",
    `script-src ${hashes.length ? hashes.join(" ") : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const REPORT_HEADERS: Record<string, string> = {
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

export function createWorkerServer(d: ServerDeps): Server {
  const origin = d.config.siteOrigin;

  const send = (res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "x-content-type-options": "nosniff", ...headers });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}) =>
    send(res, status, JSON.stringify(obj), { "content-type": "application/json", "cache-control": "no-store", ...headers });
  const notFound = (res: ServerResponse) =>
    send(res, 404, "Not found", { ...REPORT_HEADERS, "content-type": "text/plain; charset=utf-8", "content-security-policy": "default-src 'none'" });

  const cors = (req: IncomingMessage): Record<string, string> =>
    origin && req.headers.origin === origin
      ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }
      : { vary: "Origin" };

  const clientIp = (req: IncomingMessage): string => {
    if (d.config.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const readJson = (req: IncomingMessage): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }> =>
    new Promise((resolve) => {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return resolve({ ok: false, status: 415, error: "json_only" });
      const len = Number(req.headers["content-length"] ?? 0);
      if (len > MAX_BODY) return resolve({ ok: false, status: 413, error: "body_too_large" });
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on("data", (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > MAX_BODY) { done = true; resolve({ ok: false, status: 413, error: "body_too_large" }); req.resume(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (done) return;
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("shape");
          resolve({ ok: true, body: v as Record<string, unknown> });
        } catch { resolve({ ok: false, status: 400, error: "invalid_json" }); }
      });
      req.on("error", () => { if (!done) resolve({ ok: false, status: 400, error: "read_error" }); });
    });

  async function postScan(req: IncomingMessage, res: ServerResponse, h: Record<string, string>) {
    const parsed = await readJson(req);
    if (!parsed.ok) return json(res, parsed.status, { error: parsed.error }, h);
    const { url, email, turnstileToken } = parsed.body;
    if (typeof url !== "string" || url.length > 2048 || !url.trim()) return json(res, 400, { error: "invalid_url" }, h);
    if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email.trim())) return json(res, 400, { error: "invalid_email" }, h);

    let target: URL;
    try { target = await d.pipeline.validateUrl(url.trim()); }
    catch (e) { return json(res, 400, { error: "invalid_url", reason: e instanceof Error ? e.message.slice(0, 200) : undefined }, h); }

    const ip = clientIp(req);
    const cleanEmail = email.trim().toLowerCase();
    const hashes = {
      ipHash: hmacHash(d.config.secret, "ip", ip),
      emailHash: hmacHash(d.config.secret, "email", cleanEmail),
      domainHash: hmacHash(d.config.secret, "domain", registrableDomain(target.hostname)),
    };
    const limited = (r: ReturnType<Limits["check"]>): boolean => {
      if (r.ok) return false;
      json(res, 429, { error: "rate_limited", scope: r.scope, retryAfter: r.retryAfterSec }, { ...h, "retry-after": String(r.retryAfterSec) });
      return true;
    };

    if (limited(d.limits.check(hashes, d.queue.depth()))) return;

    const human = await d.verifyTurnstile(typeof turnstileToken === "string" ? turnstileToken : undefined, ip === "unknown" ? undefined : ip);
    if (!human) return json(res, 403, { error: "turnstile_failed" }, h);

    // No awaits from here on: re-check, record and enqueue are atomic on one thread.
    if (limited(d.limits.check(hashes, d.queue.depth()))) return;
    d.limits.record(hashes);
    const { id } = d.queue.enqueue({
      url: target.href,
      emailHash: hashes.emailHash,
      ipHash: hashes.ipHash,
      domain: hashes.domainHash,
      emailEnc: sealEmail(d.config.secret, cleanEmail),
    });
    return json(res, 202, { jobId: id }, h);
  }

  async function serveReport(token: string, kind: "html" | "pdf" | { asset: string }, res: ServerResponse) {
    if (!TOKEN_RE.test(token)) return notFound(res);
    const row = d.queue.reportByTokenHash(sha256Hex(token));
    if (!row || row.expires_at <= d.queue.now()) return notFound(res);
    if (kind === "html") {
      const html = await d.storage.getReportHtml(row.id);
      if (html === undefined) return notFound(res);
      return send(res, 200, html, { ...REPORT_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": reportCsp(html) });
    }
    if (kind === "pdf") {
      const pdf = await d.storage.getReportPdf(row.id);
      if (!pdf) return notFound(res);
      return send(res, 200, pdf, { ...REPORT_HEADERS, "content-type": "application/pdf", "content-disposition": 'attachment; filename="strativra-tracking-scan.pdf"', "content-security-policy": "default-src 'none'" });
    }
    if (!/^[A-Za-z0-9._-]+$/.test(kind.asset) || kind.asset.startsWith(".")) return notFound(res);
    const buf = await d.storage.getAsset(`${row.id}/${kind.asset}`);
    if (!buf) return notFound(res);
    const ext = kind.asset.split(".").pop()?.toLowerCase();
    const type = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "application/octet-stream";
    return send(res, 200, buf, { ...REPORT_HEADERS, "content-type": type, "content-security-policy": "default-src 'none'" });
  }

  const apiKey = d.config.apiKey ? Buffer.from(`Bearer ${d.config.apiKey}`) : undefined;
  function authorized(req: IncomingMessage): boolean {
    if (!apiKey) return true;
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    return got.length === apiKey.length && timingSafeEqual(got, apiKey);
  }

  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const h = cors(req);
      if (req.method === "OPTIONS") return send(res, 204, "", h);

      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true, queue: d.queue.depth() });
      if (path.startsWith("/scans") && !authorized(req)) return json(res, 401, { error: "unauthorized" }, h);
      if (req.method === "POST" && path === "/scans") return await postScan(req, res, h);

      let m = path.match(/^\/scans\/([A-Za-z0-9_-]{1,40})$/);
      if (req.method === "GET" && m) {
        const job = d.queue.get(m[1]);
        if (!job) return json(res, 404, { error: "not_found" }, h);
        return json(res, 200, { id: job.id, status: job.status, position: d.queue.position(job), error: job.status === "failed" ? job.error : undefined }, h);
      }
      m = path.match(/^\/r\/([^/]+)(?:\/(pdf)|\/assets\/([^/]+))?$/);
      if (req.method === "GET" && m) return await serveReport(m[1], m[2] ? "pdf" : m[3] ? { asset: m[3] } : "html", res);

      return json(res, 404, { error: "not_found" }, h);
    } catch (e) {
      d.log?.(`request error: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "internal" });
    }
  });
}
