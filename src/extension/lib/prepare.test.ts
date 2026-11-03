import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { parseCaptureUpload } from "../../core/upload.ts";
import { buildCapture, type RecordingInput, type UploadEnvelope } from "./build.ts";
import { CAPS, enforceRequestCap, gzip, PackError, packForUpload, redactForUpload, removeHost, summarize } from "./prepare.ts";
import type { RawRequest } from "./record.ts";

const T0 = 1_700_000_000_000;
const SITE = "https://shop.example/";
const GA = "https://www.google-analytics.com/g/collect";

function rec(over: Partial<RecordingInput> = {}): RecordingInput {
  return {
    target: `${SITE}?utm_source=x&email=jane.doe%40example.com`,
    startedAt: T0,
    stoppedAt: T0 + 30_000,
    userAgent: "Mozilla/5.0 Chrome/153",
    visitor: "fresh",
    marker: { ts: T0 + 3000, choice: "accept", source: "button" },
    requests: [
      { rid: "1", url: SITE, method: "GET", type: "main_frame", ts: T0 + 10, pageUrl: SITE, frameId: 0 },
      {
        rid: "2",
        url: `${GA}?v=2&tid=G-AAA&cid=123456789.1700000000&en=page_view&dl=${encodeURIComponent(`${SITE}thanks?email=jane.doe@example.com&ok=1`)}&ep.user_email=jane.doe%40example.com`,
        method: "POST",
        type: "ping",
        ts: T0 + 500,
        pageUrl: SITE,
        frameId: 0,
        body: "en=scroll&ep.phone=%2B33612345678\nen=click&uid=u-42",
      },
      { rid: "3", url: `${SITE}api/lead`, method: "POST", type: "xmlhttprequest", ts: T0 + 600, pageUrl: SITE, frameId: 0, body: '{"email":"jane.doe@example.com","phone":"+33 6 12 34 56 78"}' },
      { rid: "4", url: "https://www.facebook.com/tr/?id=1234567890123456&ev=PageView&ud[em]=abc123", method: "GET", type: "image", ts: T0 + 4000, pageUrl: SITE, frameId: 0 },
      { rid: "5", url: "https://cdn.other.net/x.js", method: "GET", type: "script", ts: T0 + 4100, pageUrl: SITE, frameId: 0 },
    ],
    errors: [],
    dataLayer: [
      { t: T0 + 100, p: { event: "page_meta", user_email: "[email]", phone: "[digits:1a2b]", order: 42, customer: { email: "jane.doe@example.com" } }, pageUrl: SITE },
    ],
    ics: [],
    droppedPushes: 0,
    navs: [{ ts: T0 + 5, url: SITE, kind: "commit", status: 200 }],
    clicks: [],
    cookies: [{ ts: T0 + 20_000, list: [{ name: "_ga", domain: ".shop.example" }] }],
    steps: [],
    clientVersion: "0.1.0",
    ...over,
  };
}

const json = (v: unknown) => JSON.stringify(v);

test("redaction of uploads: emails, ids, PII keys and phones never leave; shape survives", () => {
  const env = redactForUpload(buildCapture(rec()));
  const out = json(env);
  assert.doesNotMatch(out, /jane\.doe/);
  assert.doesNotMatch(out, /example\.com/);
  assert.doesNotMatch(out, /123456789\.1700000000/);
  assert.doesNotMatch(out, /\+33|612345678/);
  assert.doesNotMatch(out, /u-42/);
  const run = env.capture.scenarios[0];
  const ga = run.requests.find((r) => r.url.startsWith(GA))!;
  const q = new URL(ga.url).searchParams;
  assert.equal(q.get("tid"), "G-AAA");
  assert.equal(q.get("en"), "page_view");
  assert.equal(q.get("cid"), "[redacted]", "the key stays so decoders see the shape");
  assert.match(q.get("dl")!, /ok=1/);
  assert.ok(ga.postData && /en=scroll/.test(ga.postData) && /en=click/.test(ga.postData));
  // Long ids decoders need are left alone.
  assert.match(run.requests.find((r) => r.url.includes("facebook"))!.url, /id=1234567890123456/);
  // A form POST to the site itself loses its body.
  assert.equal(run.requests.find((r) => r.url.includes("api/lead"))!.postData, undefined);
  assert.equal(run.dataLayer[0].payload && (run.dataLayer[0].payload as { customer: { email: string } }).customer.email, "[redacted]");
  assert.equal(env.capture.target.includes("jane"), false);
  assert.equal(env.consentMarkerTs, 3000);
  assert.equal(env.visitor, "fresh");
  assert.equal(env.clientVersion, "0.1.0");
});

test("the redacted upload is accepted unchanged by the engine's parser (phases, ids, steps)", () => {
  const env = redactForUpload(buildCapture(rec()));
  const again = parseCaptureUpload(JSON.parse(json(env)));
  const a = env.capture.scenarios[0];
  const b = again.capture.scenarios[0];
  assert.deepEqual(b.requests.map((r) => [r.id, r.phase, r.ts, r.url]), a.requests.map((r) => [r.id, r.phase, r.ts, r.url]));
  assert.deepEqual(b.dataLayer, a.dataLayer);
  assert.deepEqual(again.guidedSteps, env.guidedSteps);
  assert.equal(again.consentMarkerTs, 3000);
});

test("request cap: at most 5,000, tracking requests kept first, noted on the run", () => {
  const many: RawRequest[] = [];
  for (let i = 0; i < 5200; i++) many.push({ rid: `n${i}`, url: `https://cdn.example.net/a${i}.png`, method: "GET", type: "image", ts: T0 + i, pageUrl: SITE, frameId: 0 });
  for (let i = 0; i < 30; i++) many.push({ rid: `g${i}`, url: `${GA}?v=2&tid=G-AAA&en=e${i}`, method: "POST", type: "ping", ts: T0 + 6000 + i, pageUrl: SITE, frameId: 0 });
  const env = buildCapture(rec({ requests: many }));
  const { env: capped, dropped } = enforceRequestCap(env);
  const reqs = capped.capture.scenarios[0].requests;
  assert.equal(reqs.length, CAPS.requests);
  assert.equal(dropped, 230);
  assert.equal(reqs.filter((r) => r.url.startsWith(GA)).length, 30);
  assert.deepEqual(reqs.map((r) => r.ts), [...reqs.map((r) => r.ts)].sort((x, y) => x - y), "time order kept");
  assert.match(capped.capture.scenarios[0].errors.at(-1)!, /230 requests over the 5000 request cap/);
  // And the engine parser accepts it (it refuses more than 5,000 with 413).
  assert.equal(redactForUpload(env).capture.scenarios[0].requests.length, CAPS.requests);
});

test("bodies over 64 KB are cut to 64 KB of UTF-8", () => {
  const big = "en=page_view&ep.note=" + "é".repeat(40_000);
  const env = redactForUpload(buildCapture(rec({ requests: [{ rid: "1", url: `${GA}?v=2&tid=G-AAA`, method: "POST", type: "ping", ts: T0 + 1, pageUrl: SITE, frameId: 0, body: big }] })));
  const body = env.capture.scenarios[0].requests[0].postData!;
  assert.ok(new TextEncoder().encode(body).byteLength <= CAPS.bodyBytes);
});

test("review: counts, hosts with vendors, and removing a host", () => {
  const env = redactForUpload(buildCapture(rec()));
  const s = summarize(env);
  assert.equal(s.requests, 5);
  assert.equal(s.tracking, 2);
  assert.equal(s.dataLayer, 1);
  assert.equal(s.cookies, 1, "distinct cookie names per run (only a post snapshot here)");
  assert.equal(s.scenario, "accept");
  assert.deepEqual(s.hosts.map((h) => h.host).slice(0, 2).sort(), ["www.facebook.com", "www.google-analytics.com"]);
  assert.deepEqual(s.hosts.find((h) => h.host === "www.google-analytics.com")!.vendors, ["ga4"]);
  assert.equal(s.hosts.find((h) => h.host === "shop.example")!.firstParty, true);
  const without = removeHost(env, "cdn.other.net");
  assert.equal(summarize(without).requests, 4);
  assert.ok(!json(without).includes("cdn.other.net"));
  assert.equal(summarize(env).requests, 5, "removeHost does not mutate");
});

test("pack: gzip round trip under the cap; reduces, then refuses when it cannot fit", async () => {
  const env = redactForUpload(buildCapture(rec()));
  const packed = await packForUpload(env);
  assert.deepEqual(JSON.parse(gunzipSync(packed.gz).toString("utf8")), JSON.parse(json(env)));
  assert.deepEqual(packed.reductions, []);

  // Many non-tracking requests with incompressible URLs and a tiny cap: the first reducer drops them.
  const noise: RawRequest[] = [];
  for (let i = 0; i < 400; i++) noise.push({ rid: `n${i}`, url: `https://cdn.example.net/${crypto.randomUUID()}${crypto.randomUUID()}.png`, method: "GET", type: "image", ts: T0 + 10 + i, pageUrl: SITE, frameId: 0 });
  const noisy = redactForUpload(buildCapture(rec({ requests: [...rec().requests, ...noise] })));
  const plain = (await gzip(new TextEncoder().encode(json(noisy)))).byteLength;
  const small = await packForUpload(noisy, Math.floor(plain / 3));
  assert.equal(small.reductions.length, 1);
  assert.ok(small.gz.byteLength <= Math.floor(plain / 3));
  assert.ok(small.env.capture.scenarios[0].requests.some((r) => r.url.startsWith(GA)), "tracking kept");
  await assert.rejects(() => packForUpload(noisy, 200), PackError);
});
