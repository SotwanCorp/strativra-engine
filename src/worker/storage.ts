import { createHash, createHmac } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface Storage {
  putReport(id: string, html: string, json: string, pdf?: Buffer): Promise<void>;
  getReportHtml(id: string): Promise<string | undefined>;
  getReportPdf(id: string): Promise<Buffer | undefined>;
  getReportJson(id: string): Promise<string | undefined>;
  putAsset(key: string, buf: Buffer, contentType?: string): Promise<void>;
  getAsset(key: string): Promise<Buffer | undefined>;
  /**
   * Erasure: remove the report's html, json, pdf and assets. Idempotent. `assets` lists the asset file
   * names stored under `<id>/` (the local store removes the whole folder, R2 cannot list so it needs the names).
   */
  deleteReport(id: string, assets?: string[]): Promise<void>;
  /** Remove files older than `days`. R2 relies on the bucket lifecycle rule, so it returns 0. */
  deleteOlderThan(days: number): Promise<number>;
}

const SAFE_PART = /^[A-Za-z0-9._-]+$/;
export function safeKey(key: string): string {
  const parts = key.split("/");
  if (!parts.length || parts.some((p) => !SAFE_PART.test(p) || p === "." || p === "..")) throw new Error("invalid storage key");
  return parts.join("/");
}

/* ----------------------------- local filesystem ---------------------------- */

export class LocalStorage implements Storage {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = resolve(dataDir);
  }
  private reportDir(id: string) { return join(this.root, "reports", safeKey(id)); }
  private assetPath(key: string) { return join(this.root, "assets", safeKey(key)); }

  async putReport(id: string, html: string, json: string, pdf?: Buffer) {
    const d = this.reportDir(id);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "report.html"), html);
    await writeFile(join(d, "report.json"), json);
    if (pdf) await writeFile(join(d, "report.pdf"), pdf);
  }
  private async read(p: string): Promise<Buffer | undefined> {
    try { return await readFile(p); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async getReportHtml(id: string) { return (await this.read(join(this.reportDir(id), "report.html")))?.toString("utf8"); }
  async getReportJson(id: string) { return (await this.read(join(this.reportDir(id), "report.json")))?.toString("utf8"); }
  async getReportPdf(id: string) { return this.read(join(this.reportDir(id), "report.pdf")); }
  async putAsset(key: string, buf: Buffer) {
    const p = this.assetPath(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, buf);
  }
  async getAsset(key: string) { return this.read(this.assetPath(key)); }
  async deleteReport(id: string) {
    await rm(this.reportDir(id), { recursive: true, force: true });
    await rm(join(this.root, "assets", safeKey(id)), { recursive: true, force: true });
  }
  async deleteOlderThan(days: number) {
    const cutoff = Date.now() - days * 86400_000;
    let n = 0;
    for (const sub of ["reports", "assets"]) {
      const dir = join(this.root, sub);
      let names: string[] = [];
      try { names = await readdir(dir); } catch { continue; }
      for (const name of names) {
        const p = join(dir, name);
        if (!resolve(p).startsWith(this.root + sep)) continue;
        const s = await stat(p);
        if (s.mtimeMs < cutoff) { await rm(p, { recursive: true, force: true }); n++; }
      }
    }
    return n;
  }
}

/* ------------------------ S3 compatible (Cloudflare R2) --------------------- */

export interface S3Config {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // "auto" for R2
  fetch?: typeof fetch;
  now?: () => Date;
}

const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** AWS Signature V4 for a single S3 request with no query string. Returns the headers to send. */
export function signV4(a: {
  method: string; host: string; path: string; body: Buffer; contentType?: string;
  region: string; accessKeyId: string; secretAccessKey: string; date: Date;
}): Record<string, string> {
  const amz = a.date.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260101T000000Z
  const day = amz.slice(0, 8);
  const payloadHash = hex(a.body);
  const canonicalPath = a.path.split("/").map(enc).join("/");
  const headers: Record<string, string> = { host: a.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amz };
  if (a.contentType) headers["content-type"] = a.contentType;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [a.method, canonicalPath, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${a.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + a.secretAccessKey, day), a.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  const out: Record<string, string> = { ...headers };
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${a.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

export class S3Storage implements Storage {
  readonly cfg: S3Config;
  constructor(cfg: S3Config) {
    this.cfg = cfg;
  }

  private async req(method: "PUT" | "GET" | "DELETE", key: string, body: Buffer = Buffer.alloc(0), contentType?: string): Promise<Response> {
    const url = new URL(this.cfg.endpoint);
    const path = `/${this.cfg.bucket}/${safeKey(key)}`;
    const headers = signV4({
      method, host: url.host, path, body, contentType, region: this.cfg.region ?? "auto",
      accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey,
      date: (this.cfg.now ?? (() => new Date()))(),
    });
    return (this.cfg.fetch ?? fetch)(`${url.origin}${path.split("/").map(enc).join("/")}`, {
      method, headers, body: method === "PUT" ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000),
    });
  }
  private async put(key: string, body: Buffer, type: string) {
    const r = await this.req("PUT", key, body, type);
    if (!r.ok) throw new Error(`storage put failed: ${r.status}`);
  }
  private async get(key: string): Promise<Buffer | undefined> {
    const r = await this.req("GET", key);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`storage get failed: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async putReport(id: string, html: string, json: string, pdf?: Buffer) {
    await this.put(`reports/${id}/report.html`, Buffer.from(html), "text/html; charset=utf-8");
    await this.put(`reports/${id}/report.json`, Buffer.from(json), "application/json");
    if (pdf) await this.put(`reports/${id}/report.pdf`, pdf, "application/pdf");
  }
  async getReportHtml(id: string) { return (await this.get(`reports/${id}/report.html`))?.toString("utf8"); }
  async getReportJson(id: string) { return (await this.get(`reports/${id}/report.json`))?.toString("utf8"); }
  async getReportPdf(id: string) { return this.get(`reports/${id}/report.pdf`); }
  async putAsset(key: string, buf: Buffer, contentType = "application/octet-stream") { await this.put(`assets/${key}`, buf, contentType); }
  async getAsset(key: string) { return this.get(`assets/${key}`); }
  async deleteReport(id: string, assets: string[] = []) {
    const keys = [`reports/${id}/report.html`, `reports/${id}/report.json`, `reports/${id}/report.pdf`, ...assets.map((a) => `assets/${id}/${a}`)];
    for (const k of keys) {
      const r = await this.req("DELETE", k);
      // A missing object is fine (idempotent). Anything else must surface, so the caller keeps the DB row and can retry.
      if (!r.ok && r.status !== 404) throw new Error(`storage delete failed: ${r.status}`);
    }
  }
  /** Expiry is the bucket lifecycle rule (90 days), see deploy/README.md. */
  async deleteOlderThan() { return 0; }
}
