/**
 * CONNECTORS.md section 5: scan metadata, POST /captures, the webhook summary, DELETE /reports/{id}.
 */
import assert from "node:assert/strict";
import dns from "node:dns";
import net from "node:net";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildReport } from "../core/report.ts";
import { capture as makeCapture, tagsBeforeConsent } from "../core/rules/fixtures.ts";
import { bodyWithRequests, uploadBody } from "../core/upload.fixtures.ts";
import type { CaptureUpload } from "../core/upload.ts";
import { createPipeline } from "../pipeline.ts";
import type { Enricher } from "../pipeline.ts";
import type { Report } from "../types.ts";
import { sha256Hex } from "./crypto.ts";
import { Limits } from "./limits.ts";
import type { Pipeline } from "./pipeline.ts";
import { JobQueue, openDb } from "./queue.ts";
import { Runner } from "./runner.ts";
import { createWorkerServer } from "./server.ts";
import { LocalStorage, S3Storage } from "./storage.ts";
import { summarizeReport } from "./webhook.ts";
import { fakePipeline, memQueue, tmp } from "./helpers.test-util.ts";

const SECRET = "test-secret-0123456789";
const KEY = "k-0123456789abcdef";
const AUTH = { authorization: `Bearer ${KEY}` };

interface Hook { url: string; body: Record<string, any> }

async function boot(o: { pipeline?: Pipeline; apiKey?: string | null; maxQueueDepth?: number } = {}) {
  const ctx = memQueue();
  const limits = new Limits(ctx.db, { maxQueueDepth: o.maxQueueDepth ?? 50 });
  const storage = new LocalStorage(tmp());
  const pipeline = o.pipeline ?? fakePipeline();
  const server: Server = createWorkerServer({
    config: { secret: SECRET, siteOrigin: "https://strativra.com", trustProxy: true, ...(o.apiKey === null ? {} : { apiKey: o.apiKey ?? KEY }) },
    queue: ctx.queue, limits, storage, pipeline, verifyTurnstile: async () => false,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hooks: Hook[] = [];
  const hookFetch = (async (url: string, init: RequestInit) => { hooks.push({ url, body: JSON.parse(String(init.body)) }); return new Response("ok"); }) as unknown as typeof fetch;
  const runner = new Runner({
    queue: ctx.queue, storage, pipeline, secret: SECRET, region: "EU (Germany)", concurrency: 2, jobTimeoutMs: 60_000, retentionDays: 90,
    reportBaseUrl: "https://worker.test", webhook: { url: "https://site.test/hook", secret: "whsec", fetch: hookFetch },
  });
  const drain = async () => { while (ctx.queue.depth()) { runner.tick(); await runner.idle(); } };
  let n = 0;
  const post = (path: string, body: unknown, headers: Record<string, string> = AUTH) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const postRaw = (path: string, body: Buffer, headers: Record<string, string>) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "x-forwarded-for": `198.51.100.${++n + 100}`, ...headers }, body: new Uint8Array(body) });
  const capture = (body: unknown, extra: Record<string, string> = {}) =>
    postRaw("/captures", gzipSync(JSON.stringify(body)), { "content-type": "application/json", "content-encoding": "gzip", ...AUTH, ...extra });
  return { ctx, limits, storage, server, base, hooks, runner, drain, post, postRaw, capture, close: () => server.close() };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const servers: Booted[] = [];
const start = async (o?: Parameters<typeof boot>[0]) => { const b = await boot(o); servers.push(b); return b; };
after(() => { for (const s of servers) s.close(); });

const scanBody = (n: number, extra: Record<string, unknown> = {}) => ({ url: `https://site${n}.example${n}.com/`, ...extra });

/* ------------------------------------------------------------------ */
/* queue migration                                                      */
/* ------------------------------------------------------------------ */

test("queue migration adds the columns once and keeps old rows", () => {
  const file = join(tmp(), "old.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, url TEXT NOT NULL, email_hash TEXT NOT NULL, ip_hash TEXT NOT NULL, domain TEXT NOT NULL,
    created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, error TEXT, report_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, email_enc TEXT);
    CREATE TABLE reports (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO jobs (id,status,url,email_hash,ip_hash,domain,created_at,report_id) VALUES ('legacy','queued','https://a.com/','e','i','d',1,'rep1');`);
  old.close();

  for (let i = 0; i < 2; i++) {
    const db = openDb(file); // the second open must not fail on "duplicate column"
    const q = new JobQueue(db);
    const j = q.get("legacy")!;
    assert.deepEqual([j.kind, j.source, j.trigger_kind, j.account_ref, j.site_ref, j.ai, j.input_gz], ["scan", "website", "manual", null, null, 1, null]);
    db.close();
  }
  const db = openDb(file);
  const q = new JobQueue(db);
  const { id } = q.enqueue({ url: "https://b.com/", emailHash: "e", ipHash: "i", domain: "d", source: "api", trigger: "schedule", accountRef: "acc_1", siteRef: "s-1", ai: false });
  const j = q.get(id)!;
  assert.deepEqual([j.source, j.trigger_kind, j.account_ref, j.site_ref, j.ai], ["api", "schedule", "acc_1", "s-1", 0]);
  db.close();
});

/* ------------------------------------------------------------------ */
/* POST /scans metadata                                                 */
/* ------------------------------------------------------------------ */

test("POST /scans validates source, trigger, refs and ai", async () => {
  const s = await start();
  const bad = async (extra: Record<string, unknown>, error: string) => {
    const r = await s.post("/scans", scanBody(1, extra));
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(((await r.json()) as { error: string }).error, error);
  };
  await bad({ source: "mobile" }, "invalid_source");
  await bad({ source: 3 }, "invalid_source");
  await bad({ trigger: "cron" }, "invalid_trigger");
  await bad({ accountRef: "has space" }, "invalid_account_ref");
  await bad({ accountRef: "x".repeat(65) }, "invalid_account_ref");
  await bad({ accountRef: "" }, "invalid_account_ref");
  await bad({ siteRef: "a/b" }, "invalid_site_ref");
  await bad({ siteRef: 12 }, "invalid_site_ref");
  await bad({ ai: "no" }, "invalid_ai");
  assert.equal(s.ctx.queue.depth(), 0);
  // 64 characters and null (absent) are fine
  const ok = await s.post("/scans", scanBody(2, { source: "account", trigger: "manual", accountRef: "A".repeat(64), siteRef: null, ai: true }));
  assert.equal(ok.status, 202);
});

test("POST /scans without ENGINE_API_KEY refuses platform fields (they would be spoofable) but accepts ai", async () => {
  const s = await start({ apiKey: null });
  const body = { url: "https://nokey.example-nokey.com/", email: "a@example.com", turnstileToken: "t" };
  // Turnstile is stubbed to fail in boot(): the checks under test come before it.
  for (const extra of [{ source: "account" }, { trigger: "manual" }, { accountRef: "acc_1" }, { siteRef: "s1" }]) {
    const r = await s.post("/scans", { ...body, ...extra }, {});
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "metadata_requires_api_key");
  }
  assert.equal((await s.post("/scans", { ...body, ai: false }, {})).status, 403); // got past validation, stopped by Turnstile
});

test("POST /scans: email stays required for the website, optional for platform sources", async () => {
  const s = await start();
  assert.equal((await s.post("/scans", scanBody(3))).status, 400);
  assert.equal((await s.post("/scans", scanBody(4, { source: "website" }))).status, 400);
  assert.equal((await s.post("/scans", scanBody(5, { source: "api", email: "nope" }))).status, 400);
  const ok = await s.post("/scans", scanBody(6, { source: "api", accountRef: "acc_6" }));
  assert.equal(ok.status, 202);
  const { jobId } = (await ok.json()) as { jobId: string };
  const row = s.ctx.queue.get(jobId)!;
  assert.equal(row.email_enc, null);
  assert.match(row.email_hash, /^[0-9a-f]{64}$/);
  // a website scan with an email works as before and defaults to website/manual/ai
  const web = await s.post("/scans", scanBody(7, { email: "Visitor@Example.com" }));
  const w = s.ctx.queue.get(((await web.json()) as { jobId: string }).jobId)!;
  assert.deepEqual([w.source, w.trigger_kind, w.account_ref, w.site_ref, w.ai, w.kind], ["website", "manual", null, null, 1, "scan"]);
  assert.ok(w.email_enc);
});

test("scan metadata and ai reach the pipeline and are echoed in the webhook with a summary", async () => {
  const seen: Array<boolean | undefined> = [];
  const { capture: cap, hits } = tagsBeforeConsent();
  const report = buildReport(cap, hits, "free", "rep");
  const s = await start({
    pipeline: fakePipeline({
      async run(_u, o) { seen.push(o.ai); return { report, html: "<p>r</p>", pdf: Buffer.from("%PDF") }; },
    }),
  });
  const a = await s.post("/scans", scanBody(10, { source: "wordpress", trigger: "change_event", accountRef: "acc_10", siteRef: "site_10", ai: false }));
  assert.equal(a.status, 202);
  const b = await s.post("/scans", scanBody(11, { email: "w@example.com" }));
  assert.equal(b.status, 202);
  await s.drain();
  assert.deepEqual(seen.sort(), [false, true]);

  const pa = s.hooks.find((h) => h.body.accountRef === "acc_10")!.body;
  assert.equal(pa.event, "scan.done");
  assert.deepEqual([pa.source, pa.trigger, pa.accountRef, pa.siteRef, pa.ai], ["wordpress", "change_event", "acc_10", "site_10", false]);
  assert.equal(pa.email, undefined);
  assert.match(pa.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(pa.reportUrl, `https://worker.test/r/${pa.token}`);
  // summary: counts, top 3 open findings, conversion statuses
  assert.deepEqual(pa.summary.counts, report.counts);
  assert.ok(pa.summary.top.length >= 1 && pa.summary.top.length <= 3);
  assert.deepEqual(pa.summary.top.map((t: any) => t.id), report.open.slice(0, 3));
  for (const t of pa.summary.top) assert.deepEqual(Object.keys(t).sort(), ["id", "severity", "title"]);
  assert.deepEqual(pa.summary.conversions, report.conversions.map((c) => ({ type: c.type, status: c.status })));
  assert.equal(pa.summary.aborted, undefined);

  // the website scan keeps the old fields, with the defaults for the new ones
  const pb = s.hooks.find((h) => h.body.email === "w@example.com")!.body;
  assert.deepEqual([pb.source, pb.trigger, pb.accountRef, pb.siteRef, pb.ai], ["website", "manual", undefined, undefined, true]);
  assert.ok(pb.token && pb.reportId && pb.jobId && pb.url);
});

test("scan.failed echoes the metadata and has no summary", async () => {
  const s = await start({ pipeline: fakePipeline({ run: async () => { throw new Error("unreachable"); } }) });
  await s.post("/scans", scanBody(12, { source: "api", trigger: "schedule", accountRef: "acc_12" }));
  await s.drain();
  const p = s.hooks[0].body;
  assert.equal(p.event, "scan.failed");
  assert.deepEqual([p.source, p.trigger, p.accountRef, p.ai, p.summary, p.token], ["api", "schedule", "acc_12", true, undefined, undefined]);
});

test("summarizeReport: top 3 of the open findings, aborted reason, tolerant of odd input", () => {
  const aborted = buildReport(makeCapture({ target: "https://x.example/", aborted: { reason: "bot_protection", detail: "Cloudflare challenge" } }), [], "free", "r");
  assert.deepEqual(summarizeReport(aborted)?.aborted, { reason: "bot_protection", detail: "Cloudflare challenge" });
  const many = { counts: { critical: 1, high: 2 }, open: ["a", "b", "c", "d", "zzz"], findings: ["a", "b", "c", "d"].map((id) => ({ id, title: `T ${id}`, severity: "high" })), conversions: [{ type: "lead", status: "ok" }, { nope: 1 }], scan: {} };
  const s = summarizeReport(many)!;
  assert.deepEqual(s.counts, { critical: 1, high: 2, medium: 0, low: 0 });
  assert.deepEqual(s.top.map((t) => t.id), ["a", "b", "c"]);
  assert.deepEqual(s.conversions, [{ type: "lead", status: "ok" }]);
  assert.equal(summarizeReport(null), undefined);
  assert.equal(summarizeReport({ target: "x" }), undefined);
});

/* ------------------------------------------------------------------ */
/* POST /captures: auth, encoding, caps, shape                          */
/* ------------------------------------------------------------------ */

const problem = async (r: Response) => {
  assert.match(r.headers.get("content-type") ?? "", /^application\/problem\+json/);
  return (await r.json()) as { type: string; title: string; status: number; code: string; error: string; detail?: string };
};

test("POST /captures needs the bearer key and is closed when no key is configured", async () => {
  const s = await start();
  const body = gzipSync(JSON.stringify(uploadBody()));
  const h = { "content-type": "application/json", "content-encoding": "gzip" };
  for (const auth of [{}, { authorization: "Bearer wrong" }] as Array<Record<string, string>>) {
    const r = await s.postRaw("/captures", body, { ...h, ...auth });
    assert.equal(r.status, 401);
    assert.equal((await problem(r)).code, "unauthorized");
  }
  assert.equal((await fetch(`${s.base}/reports/abc`, { method: "DELETE" })).status, 401);
  const open = await start({ apiKey: null });
  assert.equal((await open.postRaw("/captures", body, h)).status, 401);
  assert.equal((await fetch(`${open.base}/reports/abc`, { method: "DELETE" })).status, 401);
});

test("POST /captures: gzip and plain JSON are accepted; the job is a queued capture with the right metadata", async () => {
  const s = await start();
  const r = await s.capture(uploadBody());
  assert.equal(r.status, 202);
  const { jobId } = (await r.json()) as { jobId: string };
  const row = s.ctx.queue.get(jobId)!;
  assert.deepEqual([row.kind, row.status, row.source, row.trigger_kind, row.account_ref, row.site_ref, row.ai], ["capture", "queued", "extension", "upload", "acc_42", "site-7", 0]);
  assert.equal(row.email_enc, null);
  assert.equal(row.url, "https://shop.example/");
  // GET /scans/:id answers for captures too
  assert.equal(((await (await fetch(`${s.base}/scans/${jobId}`, { headers: AUTH })).json()) as { status: string }).status, "queued");

  const plain = await s.postRaw("/captures", Buffer.from(JSON.stringify(uploadBody({ ai: true, accountRef: null }))), { "content-type": "application/json", ...AUTH });
  assert.equal(plain.status, 202);
  const p = s.ctx.queue.get(((await plain.json()) as { jobId: string }).jobId)!;
  assert.deepEqual([p.ai, p.account_ref], [1, null]);
});

test("POST /captures: the stored upload is already redacted", async () => {
  const s = await start();
  const { jobId } = (await (await s.capture(uploadBody())).json()) as { jobId: string };
  const stored = gunzipSync(Buffer.from(s.ctx.queue.get(jobId)!.input_gz!)).toString("utf8");
  assert.ok(!/john|jane|@y\.com|a%40b|bob@|me@site|SECRETVALUE|fb\.1\.SECRET|user:secret|1234567890\.1234567890|21612345678|hashedvalue/i.test(stored), stored.match(/.{30}(john|jane|SECRET).{30}/i)?.[0]);
  const up = JSON.parse(stored) as CaptureUpload;
  assert.equal(up.capture.region, "Recorded in your browser");
  assert.equal(up.consentMarkerTs, 2000);
});

test("POST /captures: caps answer 413 problems (as sent, unzipped, request count)", async () => {
  const s = await start();
  const h = { "content-type": "application/json", "content-encoding": "gzip", ...AUTH };

  const big = await s.postRaw("/captures", randomBytes(2 * 1024 * 1024 + 16), h);
  assert.equal(big.status, 413);
  assert.equal((await problem(big)).code, "payload_too_large");

  // 11 MB of JSON squeezed into a few KB: the decompressed cap catches it while unzipping
  const bomb = gzipSync(Buffer.from('{"x":"' + "a".repeat(11 * 1024 * 1024) + '"}'));
  assert.ok(bomb.length < 100_000);
  const b = await s.postRaw("/captures", bomb, h);
  assert.equal(b.status, 413);
  assert.match((await problem(b)).detail ?? "", /unzipped/);

  const many = await s.capture(bodyWithRequests(5001));
  assert.equal(many.status, 413);
  assert.match((await problem(many)).detail ?? "", /5001 requests/);

  assert.equal((await s.capture(bodyWithRequests(5000))).status, 202);
  assert.equal(s.ctx.queue.depth(), 1);
});

test("POST /captures: bad bodies answer 400/415 problems and queue nothing", async () => {
  const s = await start();
  const gz = { "content-type": "application/json", "content-encoding": "gzip", ...AUTH };
  const cases: Array<[string, Response, number, string]> = [
    ["not gzip", await s.postRaw("/captures", Buffer.from("not gzip at all"), gz), 400, "invalid_gzip"],
    ["not json", await s.postRaw("/captures", gzipSync("{nope"), gz), 400, "invalid_json"],
    ["array", await s.postRaw("/captures", gzipSync("[1]"), gz), 400, "invalid_json"],
    ["no capture", await s.capture({}), 400, "invalid_capture"],
    ["bad request url", await s.capture((() => { const b = uploadBody() as any; b.capture.scenarios[0].requests[0].url = 5; return b; })()), 400, "invalid_capture"],
    ["bad phase", await s.capture((() => { const b = uploadBody() as any; b.capture.scenarios[0].requests[0].phase = "mid"; return b; })()), 400, "invalid_capture"],
    ["wrong source", await s.capture(uploadBody({ source: "website" })), 400, "invalid_source"],
    ["wrong trigger", await s.capture(uploadBody({ trigger: "manual" })), 400, "invalid_trigger"],
    ["bad accountRef", await s.capture(uploadBody({ accountRef: "a b" })), 400, "invalid_account_ref"],
    ["bad ai", await s.capture(uploadBody({ ai: 1 })), 400, "invalid_ai"],
    ["text/plain", await s.postRaw("/captures", Buffer.from("{}"), { "content-type": "text/plain", ...AUTH }), 415, "unsupported_media_type"],
    ["deflate", await s.postRaw("/captures", Buffer.from("{}"), { "content-type": "application/json", "content-encoding": "deflate", ...AUTH }), 415, "unsupported_encoding"],
  ];
  for (const [name, r, status, code] of cases) {
    assert.equal(r.status, status, name);
    const p = await problem(r);
    assert.equal(p.code, code, name);
    assert.equal(p.error, code, name);
    assert.equal(p.status, status, name);
  }
  const shape = await problem(await s.capture((() => { const b = uploadBody() as any; b.capture.scenarios[0].requests[0].url = 5; return b; })()));
  assert.match(shape.detail ?? "", /capture\.scenarios\[0\]\.requests\[0\]\.url/);
  assert.equal(s.ctx.queue.depth(), 0);
});

test("POST /captures obeys the queue depth cap but not the per-IP or per-account scan limits", async () => {
  const s = await start({ maxQueueDepth: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await s.capture(uploadBody())).status, 202); // same account, same site, same address
  const full = await s.capture(uploadBody());
  assert.equal(full.status, 429);
  assert.equal((await problem(full)).code, "rate_limited");
  assert.ok(Number(full.headers.get("retry-after")) > 0);
});

/* ------------------------------------------------------------------ */
/* Captures end to end, with the real pipeline                          */
/* ------------------------------------------------------------------ */

function instrument() {
  const connects: string[] = [];
  const lookups: string[] = [];
  const fetched: string[] = [];
  const origConnect = net.Socket.prototype.connect;
  const origLookup = dns.lookup;
  const origPLookup = dns.promises.lookup;
  const origFetch = globalThis.fetch;
  (net.Socket.prototype as any).connect = function (this: net.Socket, ...args: any[]) {
    // net.connect hands connect() either (options, cb), (port, host) or its normalised form [options, cb]
    const a = Array.isArray(args[0]) ? args[0][0] : args[0];
    connects.push(typeof a === "object" && a ? String(a.host ?? a.path ?? "") : String(args[1] ?? ""));
    return (origConnect as any).apply(this, args);
  };
  (dns as any).lookup = (...a: any[]) => { lookups.push(String(a[0])); return (origLookup as any)(...a); };
  (dns.promises as any).lookup = (...a: any[]) => { lookups.push(String(a[0])); return (origPLookup as any)(...a); };
  globalThis.fetch = ((u: any, i?: any) => { fetched.push(String(u?.url ?? u)); return origFetch(u, i); }) as typeof fetch;
  return {
    connects, lookups, fetched,
    restore() {
      net.Socket.prototype.connect = origConnect;
      (dns as any).lookup = origLookup;
      (dns.promises as any).lookup = origPLookup;
      globalThis.fetch = origFetch;
    },
  };
}

test("a capture becomes a report with no network access, no browsing and no site lookup", async () => {
  const enrichCalls: Report[] = [];
  const enrich: Enricher = async (r) => { enrichCalls.push(r); return r; };
  const real = createPipeline({ pdf: true, enrich });
  let validateCalls = 0;
  const pipeline: Pipeline = { ...real, validateUrl: async (i) => { validateCalls++; return real.validateUrl(i); } };
  const s = await start({ pipeline });

  const spy = instrument();
  let jobId: string;
  try {
    const r = await s.capture(uploadBody());
    assert.equal(r.status, 202);
    ({ jobId } = (await r.json()) as { jobId: string });
    await s.drain();
    // only the in-process test server was ever dialled; the recorded site and the vendors were not
    assert.ok(spy.connects.length > 0 && spy.connects.every((h) => h === "127.0.0.1"), JSON.stringify(spy.connects));
    assert.deepEqual(spy.lookups, []);
    assert.ok(spy.fetched.every((u) => u.startsWith(s.base)), JSON.stringify(spy.fetched));
  } finally {
    spy.restore();
  }
  assert.equal(validateCalls, 0, "validateUrl (DNS) must not run for captures");
  assert.equal(s.hooks.length, 1);
  assert.equal(s.hooks.every((h) => h.url === "https://site.test/hook"), true);
  assert.equal(enrichCalls.length, 0, "the upload said ai:false");

  const job = s.ctx.queue.get(jobId);
  assert.equal(job?.status, "done");
  assert.equal(job?.input_gz, null, "the uploaded input is dropped when the job finishes");

  const p = s.hooks[0].body;
  assert.equal(p.event, "scan.done");
  assert.deepEqual([p.source, p.trigger, p.accountRef, p.siteRef, p.ai, p.email], ["extension", "upload", "acc_42", "site-7", false, undefined]);
  assert.equal(p.url, "https://shop.example/");
  assert.ok(p.summary.top.length >= 1);
  assert.ok(p.summary.top.some((t: any) => t.id === "consent.fires_before_consent"), JSON.stringify(p.summary.top));
  assert.ok(p.summary.conversions.some((c: any) => c.type === "purchase"));

  // the report: region, recording block with the guided steps, no PII, a PDF
  const html = (await s.storage.getReportHtml(p.reportId))!;
  const json = JSON.parse((await s.storage.getReportJson(p.reportId))!) as Report;
  assert.equal(json.region, "Recorded in your browser");
  assert.equal(json.recording?.guidedSteps.length, 4);
  assert.equal(json.recording?.source, "extension");
  assert.ok(html.includes("What you recorded") && html.includes("Recorded in your browser") && html.includes("add_to_cart") && html.includes("stop_before_submit"));
  assert.ok(!html.includes("Scanned from"));
  assert.ok(!/[–—]/.test(html), "no en or em dashes in the report");
  assert.ok(!/john|jane|@example\.com|SECRETVALUE|21612345678/i.test(html + JSON.stringify(json)));
  // view_item was recorded before the consent click and GA4 sent no view_item: a funnel finding on the guided point
  const funnel = json.findings.find((f) => f.id === "conversion.funnel_step_untracked");
  assert.ok(funnel, json.findings.map((f) => f.id).join(", "));
  assert.ok(JSON.stringify(funnel.evidence).includes("guided-purchase"));
  assert.equal((await s.storage.getReportPdf(p.reportId))?.subarray(0, 4).toString(), "%PDF");

  // served by the private token like a scan report
  const page = await fetch(`${s.base}/r/${p.token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
});

test("ai:false skips enrichment; ai:true runs the enricher (uploads and finishReport)", async () => {
  const calls: string[] = [];
  const enrich: Enricher = async (r, _c, kind) => { calls.push(kind); return r; };
  const pipeline = createPipeline({ pdf: false, enrich });
  const up = (await import("../core/upload.ts")).parseCaptureUpload(uploadBody());
  const off = await pipeline.fromCapture(up, { reportId: "r1", ai: false });
  assert.deepEqual(calls, []);
  assert.ok((off.report as Report).plan, "the deterministic plan still renders");
  await pipeline.fromCapture(up, { reportId: "r2" });
  await pipeline.fromCapture(up, { reportId: "r3", ai: true });
  assert.deepEqual(calls, ["free", "free"]);

  // a failing enricher never loses the report
  const broken = createPipeline({ pdf: false, enrich: async () => { throw new Error("model down"); } });
  assert.ok((await broken.fromCapture(up, { reportId: "r4" })).html.includes("<h1>"));

  // through the worker: ai on the job reaches fromCapture
  const seen: Array<boolean | undefined> = [];
  const s = await start({ pipeline: fakePipeline({ async fromCapture(u, o) { seen.push(o.ai); return { report: {}, html: `<p>${u.capture.target}</p>` }; } }) });
  await s.capture(uploadBody({ ai: false }));
  await s.capture(uploadBody({ ai: true }));
  await s.capture((() => { const b = uploadBody(); delete b.ai; return b; })());
  await s.drain();
  assert.deepEqual(seen, [false, true, true]);
});

test("a capture whose pipeline fails reports scan.failed with the metadata and drops the input", async () => {
  const s = await start({ pipeline: fakePipeline({ fromCapture: async () => { throw new Error("render_failed"); } }) });
  const { jobId } = (await (await s.capture(uploadBody())).json()) as { jobId: string };
  await s.drain();
  const job = s.ctx.queue.get(jobId)!;
  assert.deepEqual([job.status, job.error, job.input_gz], ["failed", "render_failed", null]);
  const p = s.hooks[0].body;
  assert.deepEqual([p.event, p.source, p.trigger, p.accountRef, p.siteRef, p.error], ["scan.failed", "extension", "upload", "acc_42", "site-7", "render_failed"]);
});

/* ------------------------------------------------------------------ */
/* DELETE /reports/{reportId}                                           */
/* ------------------------------------------------------------------ */

test("DELETE /reports/{id} erases html, json, pdf, assets and the rows; repeating it is still 204", async () => {
  const pipeline = fakePipeline({
    async run(_u, o) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(o.screenshotDir, "shot-1.png"), "png");
      return { report: { counts: { critical: 0, high: 0, medium: 0, low: 0 }, findings: [], open: [], conversions: [] }, html: "<p>secret report</p>", pdf: Buffer.from("%PDF") };
    },
  });
  const s = await start({ pipeline });
  await s.post("/scans", scanBody(20, { source: "api" }));
  await s.drain();
  const p = s.hooks[0].body;
  assert.equal((await fetch(`${s.base}/r/${p.token}`)).status, 200);
  assert.equal((await fetch(`${s.base}/r/${p.token}/assets/shot-1.png`)).status, 200);
  assert.deepEqual(s.ctx.queue.reportAssets(p.reportId), ["shot-1.png"]);

  assert.equal((await fetch(`${s.base}/reports/${p.reportId}`, { method: "DELETE" })).status, 401);
  const del = await fetch(`${s.base}/reports/${p.reportId}`, { method: "DELETE", headers: AUTH });
  assert.equal(del.status, 204);
  assert.equal(await del.text(), "");

  assert.equal((await fetch(`${s.base}/r/${p.token}`)).status, 404);
  assert.equal((await fetch(`${s.base}/r/${p.token}/pdf`)).status, 404);
  assert.equal((await fetch(`${s.base}/r/${p.token}/assets/shot-1.png`)).status, 404);
  assert.equal(await s.storage.getReportHtml(p.reportId), undefined);
  assert.equal(await s.storage.getReportJson(p.reportId), undefined);
  assert.equal(await s.storage.getReportPdf(p.reportId), undefined);
  assert.equal(await s.storage.getAsset(`${p.reportId}/shot-1.png`), undefined);
  assert.equal(s.ctx.queue.reportByTokenHash(sha256Hex(p.token)), undefined);
  assert.equal(s.ctx.queue.get(p.jobId), undefined);

  // idempotent: again, and for an id that never existed
  assert.equal((await fetch(`${s.base}/reports/${p.reportId}`, { method: "DELETE", headers: AUTH })).status, 204);
  assert.equal((await fetch(`${s.base}/reports/neverexisted`, { method: "DELETE", headers: AUTH })).status, 204);
  // other reports are untouched
  await s.post("/scans", scanBody(21, { source: "api" }));
  await s.drain();
  const other = s.hooks[1].body;
  assert.equal((await fetch(`${s.base}/reports/${p.reportId}`, { method: "DELETE", headers: AUTH })).status, 204);
  assert.equal((await fetch(`${s.base}/r/${other.token}`)).status, 200);
});

test("DELETE of a queued job cancels it; of a running job discards its result and sends no webhook", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  const s = await start({
    pipeline: fakePipeline({ run: async () => { started(); await gate; return { report: {}, html: "<p>late</p>", pdf: Buffer.from("%PDF") }; } }),
  });

  const first = (await (await s.post("/scans", scanBody(30, { source: "api" }))).json()) as { jobId: string };
  s.runner.tick();
  await running;
  const row = s.ctx.queue.get(first.jobId)!;
  assert.equal(row.status, "running");
  assert.equal((await fetch(`${s.base}/reports/${row.report_id}`, { method: "DELETE", headers: AUTH })).status, 204);
  assert.equal(s.ctx.queue.get(first.jobId), undefined);
  release();
  await s.runner.idle();
  assert.equal(await s.storage.getReportHtml(row.report_id), undefined, "a finished run must not write an erased report");
  assert.equal(s.hooks.length, 0);

  // queued: erased before it ever runs
  const q = await start();
  const queued = (await (await q.post("/scans", scanBody(31, { source: "api" }))).json()) as { jobId: string };
  const qrow = q.ctx.queue.get(queued.jobId)!;
  assert.equal((await fetch(`${q.base}/reports/${qrow.report_id}`, { method: "DELETE", headers: AUTH })).status, 204);
  assert.equal(q.ctx.queue.claim(2), undefined);
});

test("S3 erasure removes the asset objects too and surfaces storage errors", async () => {
  const deleted: string[] = [];
  let failWith: number | undefined;
  const fake = (async (url: string, init: RequestInit) => {
    if (init.method === "DELETE") { deleted.push(url); return new Response(null, { status: failWith ?? 204 }); }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const s3 = new S3Storage({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "bkt", accessKeyId: "A", secretAccessKey: "S", fetch: fake });
  await s3.deleteReport("rep1", ["shot-1.png", "shot-2.jpg"]);
  assert.deepEqual(deleted.map((u) => u.replace("https://acct.r2.cloudflarestorage.com/bkt/", "")), [
    "reports/rep1/report.html", "reports/rep1/report.json", "reports/rep1/report.pdf", "assets/rep1/shot-1.png", "assets/rep1/shot-2.jpg",
  ]);
  failWith = 404; // already gone is fine
  await s3.deleteReport("rep1");
  failWith = 500;
  await assert.rejects(s3.deleteReport("rep1"), /storage delete failed: 500/);

  // the endpoint answers 500 so the platform retries
  const ctx = memQueue();
  const server = createWorkerServer({
    config: { secret: SECRET, trustProxy: true, apiKey: KEY }, queue: ctx.queue, limits: ctx.limits, storage: s3, pipeline: fakePipeline(), verifyTurnstile: async () => false,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/reports/rep1`, { method: "DELETE", headers: AUTH });
    assert.equal(r.status, 500);
    assert.equal((await problem(r)).code, "storage_error");
  } finally {
    server.close();
  }
});
