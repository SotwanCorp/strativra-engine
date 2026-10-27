import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { gunzip, gzipSync } from "node:zlib";
import { parseCaptureUpload, UPLOAD_LIMITS, UploadError } from "../core/upload.ts";
import { parseMeta, hasPlatformFields } from "./meta.ts";
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

  /** RFC 9457 problem for the platform endpoints. `error` repeats `code` so callers of /scans can read it the same way. */
  const PROBLEM_TITLES: Record<string, string> = {
    unauthorized: "Unauthorized", payload_too_large: "Payload too large", invalid_capture: "Invalid capture", invalid_json: "Invalid JSON",
    invalid_gzip: "Invalid gzip body", unsupported_media_type: "Unsupported media type", unsupported_encoding: "Unsupported content encoding",
    rate_limited: "Rate limited", storage_error: "Storage error",
  };
  const problem = (res: ServerResponse, status: number, code: string, detail?: string, headers: Record<string, string> = {}) =>
    send(res, status, JSON.stringify({ type: "about:blank", title: PROBLEM_TITLES[code] ?? code, status, code, error: code, ...(detail ? { detail } : {}) }), {
      "content-type": "application/problem+json", "cache-control": "no-store", ...headers,
    });

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

    // source, trigger, accountRef and siteRef decide where the platform files the scan, so only an
    // authenticated caller (ENGINE_API_KEY set, bearer checked above) may send them. `ai` can only lower cost.
    if (!apiKey && hasPlatformFields(parsed.body)) return json(res, 400, { error: "metadata_requires_api_key" }, h);
    const m = parseMeta(parsed.body, { source: "website", trigger: "manual" });
    if (!m.ok) return json(res, 400, { error: m.error, detail: m.detail }, h);
    const meta = m.meta;

    // The email is the website form's lead. Account, API, WordPress and extension scans are tied to an account
    // ref instead, so an authenticated call from those sources may leave it out.
    const emailOptional = !!apiKey && meta.source !== "website";
    const emailGiven = !(email === undefined || email === null || email === "");
    if (emailGiven ? typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email.trim()) : !emailOptional) {
      return json(res, 400, { error: "invalid_email" }, h);
    }

    let target: URL;
    try { target = await d.pipeline.validateUrl(url.trim()); }
    catch (e) { return json(res, 400, { error: "invalid_url", reason: e instanceof Error ? e.message.slice(0, 200) : undefined }, h); }

    const ip = clientIp(req);
    const cleanEmail = emailGiven ? (email as string).trim().toLowerCase() : undefined;
    const hashes = {
      ipHash: hmacHash(d.config.secret, "ip", ip),
      // No email: the account is the limit key (or the caller's address when there is no account ref).
      emailHash: cleanEmail ? hmacHash(d.config.secret, "email", cleanEmail) : meta.accountRef ? hmacHash(d.config.secret, "account", meta.accountRef) : hmacHash(d.config.secret, "email-none", ip),
      domainHash: hmacHash(d.config.secret, "domain", registrableDomain(target.hostname)),
    };
    const limited = (r: ReturnType<Limits["check"]>): boolean => {
      if (r.ok) return false;
      json(res, 429, { error: "rate_limited", scope: r.scope, retryAfter: r.retryAfterSec }, { ...h, "retry-after": String(r.retryAfterSec) });
      return true;
    };

    if (limited(d.limits.check(hashes, d.queue.depth()))) return;

    // An authenticated site call (ENGINE_API_KEY) without a token: the site ran its own bot checks.
    const siteVouched = !!apiKey && (typeof turnstileToken !== "string" || turnstileToken === "");
    const human = siteVouched || (await d.verifyTurnstile(typeof turnstileToken === "string" ? turnstileToken : undefined, ip === "unknown" ? undefined : ip));
    if (!human) return json(res, 403, { error: "turnstile_failed" }, h);

    // No awaits from here on: re-check, record and enqueue are atomic on one thread.
    if (limited(d.limits.check(hashes, d.queue.depth()))) return;
    d.limits.record(hashes);
    const { id } = d.queue.enqueue({
      url: target.href,
      emailHash: hashes.emailHash,
      ipHash: hashes.ipHash,
      domain: hashes.domainHash,
      ...(cleanEmail ? { emailEnc: sealEmail(d.config.secret, cleanEmail) } : {}),
      source: meta.source,
      trigger: meta.trigger,
      accountRef: meta.accountRef,
      siteRef: meta.siteRef,
      ai: meta.ai,
    });
    return json(res, 202, { jobId: id }, h);
  }

  /** Body bytes up to `max`; more than that stops reading (the rest is drained and dropped). */
  const readBody = (req: IncomingMessage, max: number): Promise<{ ok: true; buf: Buffer } | { ok: false }> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on("data", (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > max) { done = true; chunks.length = 0; resolve({ ok: false }); return; }
        chunks.push(c);
      });
      req.on("end", () => { if (!done) resolve({ ok: true, buf: Buffer.concat(chunks) }); });
      req.on("error", () => { if (!done) { done = true; resolve({ ok: false }); } });
    });

  /**
   * POST /captures: a recording uploaded by the Chrome extension (through the platform). Bearer auth, no
   * Turnstile. gzip or plain JSON, 2 MB as sent, 10 MB once unzipped, 5,000 requests. The upload is
   * validated and re-redacted here, stored gzipped on the job, and turned into a report with no browsing.
   */
  async function postCapture(req: IncomingMessage, res: ServerResponse) {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return problem(res, 415, "unsupported_media_type", "Send Content-Type: application/json.");
    const enc = String(req.headers["content-encoding"] ?? "identity").trim().toLowerCase();
    if (enc !== "gzip" && enc !== "x-gzip" && enc !== "identity") return problem(res, 415, "unsupported_encoding", "Content-Encoding must be gzip or absent.");
    const tooLarge = (detail: string) => { req.resume(); return problem(res, 413, "payload_too_large", detail); };
    if (Number(req.headers["content-length"] ?? 0) > UPLOAD_LIMITS.compressedBytes) return tooLarge(`The body is over ${UPLOAD_LIMITS.compressedBytes} bytes as sent.`);
    const raw = await readBody(req, UPLOAD_LIMITS.compressedBytes);
    if (!raw.ok) return tooLarge(`The body is over ${UPLOAD_LIMITS.compressedBytes} bytes as sent.`);

    let jsonBuf = raw.buf;
    if (enc !== "identity") {
      const out = await new Promise<{ ok: true; buf: Buffer } | { ok: false; big: boolean }>((resolve) => {
        gunzip(raw.buf, { maxOutputLength: UPLOAD_LIMITS.decompressedBytes }, (err, buf) => {
          if (!err) return resolve({ ok: true, buf });
          resolve({ ok: false, big: (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError });
        });
      });
      if (!out.ok) return out.big ? problem(res, 413, "payload_too_large", `The body is over ${UPLOAD_LIMITS.decompressedBytes} bytes once unzipped.`) : problem(res, 400, "invalid_gzip", "The body is not valid gzip.");
      jsonBuf = out.buf;
    }
    let body: Record<string, unknown>;
    try {
      const v = JSON.parse(jsonBuf.toString("utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("shape");
      body = v as Record<string, unknown>;
    } catch { return problem(res, 400, "invalid_json", "The body is not a JSON object."); }

    const m = parseMeta(body, { source: "extension", trigger: "upload", fixed: true });
    if (!m.ok) return problem(res, 400, m.error, m.detail);
    const meta = m.meta;
    let upload;
    try { upload = parseCaptureUpload(body); }
    catch (e) {
      if (e instanceof UploadError) return problem(res, e.status, e.code, e.message);
      throw e;
    }

    const lim = d.limits.checkQueue(d.queue.depth());
    if (!lim.ok) return problem(res, 429, "rate_limited", `The queue is full (${lim.scope}). Retry later.`, { "retry-after": String(lim.retryAfterSec) });

    const ip = clientIp(req);
    let host = "";
    try { host = new URL(upload.capture.target).hostname; } catch { /* target was validated */ }
    const { id } = d.queue.enqueue({
      url: upload.capture.target,
      emailHash: meta.accountRef ? hmacHash(d.config.secret, "account", meta.accountRef) : hmacHash(d.config.secret, "email-none", ip),
      ipHash: hmacHash(d.config.secret, "ip", ip),
      domain: hmacHash(d.config.secret, "domain", registrableDomain(host)),
      kind: "capture",
      source: meta.source,
      trigger: meta.trigger,
      accountRef: meta.accountRef,
      siteRef: meta.siteRef,
      ai: meta.ai,
      input: gzipSync(JSON.stringify(upload)),
    });
    return json(res, 202, { jobId: id });
  }

  /**
   * DELETE /reports/{reportId}: erasure. reportId is the id from the webhook. Removes the DB rows first
   * (a job still running then discards its own result), then the stored html, json, pdf and assets.
   * 204 whether or not anything existed. A storage failure answers 500 so the caller retries.
   */
  async function deleteReport(reportId: string, res: ServerResponse) {
    const assets = d.queue.reportAssets(reportId);
    d.queue.eraseReport(reportId);
    try {
      await d.storage.deleteReport(reportId, assets);
    } catch (e) {
      d.log?.(`erase failed for a report: ${(e as Error).message}`);
      return problem(res, 500, "storage_error", "Stored files could not be removed. Retry.");
    }
    return send(res, 204, "", { "cache-control": "no-store" });
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
      // /captures and /reports have no Turnstile to fall back on: without ENGINE_API_KEY they stay closed.
      if ((path.startsWith("/captures") || path.startsWith("/reports")) && (!apiKey || !authorized(req))) return problem(res, 401, "unauthorized");
      if (req.method === "POST" && path === "/scans") return await postScan(req, res, h);
      if (req.method === "POST" && path === "/captures") return await postCapture(req, res);

      let m = path.match(/^\/scans\/([A-Za-z0-9_-]{1,40})$/);
      if (req.method === "GET" && m) {
        const job = d.queue.get(m[1]);
        if (!job) return json(res, 404, { error: "not_found" }, h);
        return json(res, 200, { id: job.id, status: job.status, position: d.queue.position(job), error: job.status === "failed" ? job.error : undefined }, h);
      }
      m = path.match(/^\/reports\/([A-Za-z0-9_-]{1,40})$/);
      if (req.method === "DELETE" && m) return await deleteReport(m[1], res);
      m = path.match(/^\/r\/([^/]+)(?:\/(pdf)|\/assets\/([^/]+))?$/);
      if (req.method === "GET" && m) return await serveReport(m[1], m[2] ? "pdf" : m[3] ? { asset: m[3] } : "html", res);

      return json(res, 404, { error: "not_found" }, h);
    } catch (e) {
      d.log?.(`request error: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "internal" });
    }
  });
}
