import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { newToken, openEmail, sha256Hex } from "./crypto.ts";
import { Runner } from "./runner.ts";
import { createWorkerServer } from "./server.ts";
import { LocalStorage } from "./storage.ts";
import { signBody } from "./webhook.ts";
import { fakePipeline, memQueue, tmp } from "./helpers.test-util.ts";

const SECRET = "test-secret-0123456789";
const ORIGIN = "https://strativra.com";
let server: Server;
let base: string;
let ctx: ReturnType<typeof memQueue>;
let storage: LocalStorage;
let turnstileOk = true;
const hooks: { headers: Headers; body: string }[] = [];

const webhookFetch = (async (_u: string, init: RequestInit) => {
  hooks.push({ headers: new Headers(init.headers), body: String(init.body) });
  return new Response("ok");
}) as unknown as typeof fetch;

before(async () => {
  ctx = memQueue();
  storage = new LocalStorage(tmp());
  server = createWorkerServer({
    config: { secret: SECRET, siteOrigin: ORIGIN, trustProxy: true },
    queue: ctx.queue, limits: ctx.limits, storage, pipeline: fakePipeline(),
    verifyTurnstile: async () => turnstileOk,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

let ipCounter = 0;
const post = (body: unknown, extra: Record<string, string> = {}, raw?: string) =>
  fetch(`${base}/scans`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++ipCounter}`, ...extra }, body: raw ?? JSON.stringify(body) });
const good = (n: number) => ({ url: `https://site${n}.example${n}.com/`, email: `User${n}@Example.com`, turnstileToken: "t" });

test("healthz", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal((await r.json() as { ok: boolean }).ok, true);
});

test("POST /scans validates input", async () => {
  assert.equal((await post({ ...good(1), url: "http://localhost/" })).status, 400);
  assert.equal((await post({ ...good(1), email: "nope" })).status, 400);
  assert.equal((await post(null, {}, "{bad")).status, 400);
  assert.equal((await post(null, {}, JSON.stringify({ x: "y".repeat(5000) }))).status, 413);
  assert.equal((await post(null, { "content-type": "text/plain" }, "x")).status, 415);
});

test("POST /scans: turnstile failure is 403 and consumes no limit", async () => {
  turnstileOk = false;
  assert.equal((await post(good(2))).status, 403);
  turnstileOk = true;
  assert.equal(ctx.queue.depth(), 0);
});

test("POST /scans enqueues, GET /scans/:id has no PII, DB has only hashes", async () => {
  const r = await post(good(3));
  assert.equal(r.status, 202);
  const { jobId } = await r.json() as { jobId: string };
  const s = await fetch(`${base}/scans/${jobId}`);
  const text = await s.text();
  assert.equal(JSON.parse(text).status, "queued");
  assert.ok(!/example|user3|198\.51/i.test(text));
  const row = ctx.queue.get(jobId)!;
  assert.match(row.email_hash, /^[0-9a-f]{64}$/);
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  const dump = JSON.stringify(row);
  assert.ok(!/user3@example|198\.51\.100/i.test(dump));
  assert.equal(openEmail(SECRET, row.email_enc), "user3@example.com");
  assert.equal((await fetch(`${base}/scans/unknownid`)).status, 404);
});

test("limits return 429 with Retry-After (per email)", async () => {
  const email = "same@example.com";
  for (let i = 0; i < 3; i++) assert.equal((await post({ url: `https://a${i}.limit${i}.com/`, email, turnstileToken: "t" })).status, 202);
  const r = await post({ url: "https://z.zz.com/", email, turnstileToken: "t" });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
});

test("CORS only for SITE_ORIGIN", async () => {
  const ok = await fetch(`${base}/scans`, { method: "OPTIONS", headers: { origin: ORIGIN } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  const bad = await fetch(`${base}/scans`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("runner completes a job, calls the signed webhook, report is served with hardening headers", async () => {
  const email = "runner@example.com";
  const r = await post({ url: "https://runner.runner-site.com/", email, turnstileToken: "t" });
  const { jobId } = await r.json() as { jobId: string };
  const runner = new Runner({
    queue: ctx.queue, storage, pipeline: fakePipeline(), secret: SECRET, region: "EU", concurrency: 2, jobTimeoutMs: 5000,
    retentionDays: 90, reportBaseUrl: "https://worker.test", webhook: { url: "https://site.test/hook", secret: "whsec", fetch: webhookFetch },
  });
  while (ctx.queue.depth()) { runner.tick(); await runner.idle(); }
  assert.equal(ctx.queue.get(jobId)?.status, "done");
  assert.equal(ctx.queue.get(jobId)?.email_enc, null);

  const hook = hooks.find((h) => JSON.parse(h.body).jobId === jobId)!;
  const payload = JSON.parse(hook.body);
  assert.equal(payload.event, "scan.done");
  assert.equal(payload.email, email);
  assert.equal(hook.headers.get("x-strativra-signature"), signBody("whsec", hook.headers.get("x-strativra-timestamp")!, hook.body));
  assert.equal(payload.reportUrl, `https://worker.test/r/${payload.token}`);
  assert.match(payload.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(ctx.queue.reportByTokenHash(sha256Hex(payload.token))?.id, payload.reportId);

  const page = await fetch(`${base}/r/${payload.token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /report for runner\.runner-site\.com/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  const csp = page.headers.get("content-security-policy")!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'sha256-/);
  assert.match(csp, /frame-ancestors 'none'/);

  const pdf = await fetch(`${base}/r/${payload.token}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal((await fetch(`${base}/r/${payload.token}/assets/missing.png`)).status, 404);
});

test("runner: failing pipeline marks job failed and still notifies", async () => {
  const { jobId } = await (await post({ url: "https://boom.boom-site.com/", email: "boom@example.com", turnstileToken: "t" })).json() as { jobId: string };
  const runner = new Runner({
    queue: ctx.queue, storage, pipeline: fakePipeline({ run: async () => { throw new Error("unreachable"); } }), secret: SECRET, region: "EU",
    concurrency: 2, jobTimeoutMs: 5000, retentionDays: 90, reportBaseUrl: "https://worker.test", webhook: { url: "https://site.test/hook", secret: "w", fetch: webhookFetch },
  });
  while (ctx.queue.depth()) { runner.tick(); await runner.idle(); }
  assert.equal(ctx.queue.get(jobId)?.status, "failed");
  const p = JSON.parse(hooks.find((h) => JSON.parse(h.body).jobId === jobId)!.body);
  assert.equal(p.event, "scan.failed");
  assert.equal(p.token, undefined);
});

test("runner never exceeds the concurrency limit", async () => {
  for (let i = 0; i < 4; i++) ctx.queue.enqueue({ url: `https://c${i}.com/`, emailHash: "e", ipHash: "i", domain: "d" });
  let active = 0, peak = 0;
  const slow = fakePipeline({ run: async (u, o) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return { report: {}, html: "<p>x</p>" }; } });
  const runner = new Runner({ queue: ctx.queue, storage, pipeline: slow, secret: SECRET, region: "EU", concurrency: 2, jobTimeoutMs: 5000, retentionDays: 90, reportBaseUrl: "x", webhook: { secret: "w" } });
  for (let i = 0; i < 6; i++) { runner.tick(); await new Promise((r) => setTimeout(r, 40)); }
  await runner.idle();
  assert.equal(peak, 2);
});

test("report tokens: invalid, unknown and expired all return the identical 404", async () => {
  const token = newToken();
  const { id, reportId } = ctx.queue.enqueue({ url: "https://exp.com/", emailHash: "e", ipHash: "i", domain: "d" });
  ctx.queue.claim(99);
  await storage.putReport(reportId, "<p>secret</p>", "{}");
  ctx.queue.complete(id, { tokenHash: sha256Hex(token), expiresAt: Date.now() - 1 });

  const responses = await Promise.all([`${base}/r/${token}`, `${base}/r/${newToken()}`, `${base}/r/short`, `${base}/r/${token}/pdf`].map((u) => fetch(u)));
  const snap = await Promise.all(responses.map(async (r) => ({ s: r.status, b: await r.text(), h: ["x-robots-tag", "cache-control", "content-type", "referrer-policy", "content-security-policy"].map((k) => r.headers.get(k)) })));
  for (const s of snap) { assert.equal(s.s, 404); assert.deepEqual(s, snap[0]); }
});
