import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createScan, getScan, normalizeBaseUrl, pollDelay, pollScan, scanState, uploadCapture, type ScanObject } from "./api.ts";

test("the key is only ever sent to strativra.com or a local dev copy", () => {
  assert.equal(normalizeBaseUrl(""), "https://strativra.com");
  assert.equal(normalizeBaseUrl("https://strativra.com/"), "https://strativra.com");
  assert.equal(normalizeBaseUrl("https://staging.strativra.com"), "https://staging.strativra.com");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8890"), "http://127.0.0.1:8890");
  assert.equal(normalizeBaseUrl("http://localhost:8890/"), "http://localhost:8890");
  assert.equal(normalizeBaseUrl("http://strativra.com"), null);
  assert.equal(normalizeBaseUrl("https://strativra.com.evil.example"), null);
  assert.equal(normalizeBaseUrl("https://evilstrativra.com"), null);
  assert.equal(normalizeBaseUrl("https://strativra.com/api"), null);
  assert.equal(normalizeBaseUrl("https://user:pw@strativra.com"), null);
  assert.equal(normalizeBaseUrl("http://192.168.1.2:8890"), null);
  assert.equal(normalizeBaseUrl("not a url"), null);
});

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<() => Response>, seen: Seen[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new TypeError("network");
    return next();
  }) as typeof fetch;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("createScan: POST /api/v1/scans with Bearer, JSON body and an idempotency key; cookies omitted", async () => {
  const seen: Seen[] = [];
  const f = fakeFetch([json(202, { id: "scn_1", status: "queued", position: 2 })], seen);
  const s = await createScan({ base: "https://strativra.com", key: "strv_live_k", fetch: f }, "https://site.example/");
  assert.equal(s.id, "scn_1");
  assert.equal(seen[0].url, "https://strativra.com/api/v1/scans");
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer strv_live_k");
  assert.match(h["Idempotency-Key"], /^[0-9a-f-]{36}$/);
  assert.equal(seen[0].init.credentials, "omit");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { url: "https://site.example/" });
});

test("uploadCapture: gzip body with Content-Encoding gzip", async () => {
  const seen: Seen[] = [];
  const f = fakeFetch([json(202, { id: "scn_2", status: "queued" })], seen);
  const gz = new Uint8Array([0x1f, 0x8b, 8, 0]);
  await uploadCapture({ base: "http://127.0.0.1:8890", key: "k", fetch: f }, gz);
  assert.equal(seen[0].url, "http://127.0.0.1:8890/api/v1/captures");
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h["Content-Encoding"], "gzip");
  assert.equal(h["Content-Type"], "application/json");
  assert.deepEqual(new Uint8Array(await (seen[0].init.body as Blob).arrayBuffer()), gz);
});

test("problem+json errors keep their stable code; status maps when there is none", async () => {
  const f = fakeFetch(
    [
      json(429, { type: "about:blank", title: "Too many", status: 429, code: "quota_exceeded", detail: "Monthly quota reached" }, { "retry-after": "30" }),
      () => new Response("nope", { status: 401 }),
    ],
    [],
  );
  const o = { base: "https://strativra.com", key: "k", fetch: f };
  await assert.rejects(() => getScan(o, "scn_1"), (e: ApiError) => e.code === "quota_exceeded" && e.retryAfter === 30 && e.status === 429);
  await assert.rejects(() => getScan(o, "scn_1"), (e: ApiError) => e.code === "unauthorized");
  await assert.rejects(() => getScan(o, "../me"), (e: ApiError) => e.code === "not_found");
  await assert.rejects(() => getScan({ ...o, fetch: fakeFetch([], []) }, "scn_1"), (e: ApiError) => e.code === "network");
});

test("pollScan retries transient errors and stops on done; bot protection is detected", async () => {
  const waits: number[] = [];
  const updates: string[] = [];
  const f = fakeFetch(
    [
      json(200, { id: "scn_1", status: "queued", position: 1 }),
      json(503, { code: "engine_unavailable" }),
      json(200, { id: "scn_1", status: "running" }),
      json(200, { id: "scn_1", status: "done", report_url: "https://strativra.com/r/abc", summary: { aborted: { reason: "bot_protection", detail: "HTTP 403" } } }),
    ],
    [],
  );
  const final = await pollScan({ base: "https://strativra.com", key: "k", fetch: f }, "scn_1", {
    sleep: async (ms) => void waits.push(ms),
    onUpdate: (s) => updates.push(s.status),
  });
  assert.deepEqual(updates, ["queued", "running", "done"]);
  assert.deepEqual(waits, [2000, 2000, 3000]);
  const st = scanState(final);
  assert.equal(st.ok, true);
  assert.equal(st.botProtection, true);
  assert.equal(st.reportUrl, "https://strativra.com/r/abc");
});

test("pollScan gives up on a permanent error", async () => {
  const f = fakeFetch([json(404, { code: "not_found" })], []);
  await assert.rejects(() => pollScan({ base: "https://strativra.com", key: "k", fetch: f }, "scn_x", { sleep: async () => {} }), (e: ApiError) => e.code === "not_found");
});

test("scanState: failed scans, string abort reasons, unsafe report links", () => {
  const s = (o: Partial<ScanObject>): ScanObject => ({ id: "scn_1", status: "done", ...o });
  assert.deepEqual(scanState(s({ status: "failed", summary: { aborted: "bot_protection" } })), { finished: true, ok: false, reportUrl: undefined, botProtection: true });
  assert.equal(scanState(s({ report_url: "javascript:alert(1)" })).reportUrl, undefined);
  assert.equal(scanState(s({ status: "running" })).finished, false);
  assert.equal(pollDelay(0), 2000);
  assert.equal(pollDelay(20), 10000);
  assert.equal(pollDelay(0, 30), 30000);
});
