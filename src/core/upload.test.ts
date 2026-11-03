import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUpload, parseCaptureUpload, redactEmails, redactFree, RECORDED_REGION, UploadError, UPLOAD_LIMITS } from "./upload.ts";
import { bodyWithRequests, CLEAN_COOKIE_VALUE, uploadBody } from "./upload.fixtures.ts";

const fails = (fn: () => unknown, status: number, code: string, re?: RegExp) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof UploadError, String(e));
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    if (re) assert.match(e.message, re);
    return;
  }
  assert.fail("expected an UploadError");
};

const withCapture = (patch: (c: Record<string, any>) => void) => {
  const b = uploadBody() as { capture: Record<string, any> };
  patch(b.capture);
  return b;
};

test("a full upload parses; unknown fields are dropped; region is forced", () => {
  const up = parseCaptureUpload(uploadBody());
  assert.equal(up.capture.region, RECORDED_REGION);
  assert.equal("leakedField" in up.capture, false);
  assert.equal(up.capture.scenarios.length, 1);
  assert.equal(up.consentMarkerTs, 2000);
  // the data: request is dropped, the rest kept
  assert.equal(up.droppedRequests, 1);
  assert.equal(up.capture.scenarios[0].requests.length, 6);
  assert.deepEqual(up.capture.scenarios[0].screenshots, []);
  // bogus consent key dropped, valid ones kept
  assert.deepEqual(up.capture.scenarios[0].gtagConsent, { pre: { ad_storage: "granted" }, post: { analytics_storage: "granted" } });
});

test("phases come from consentMarkerTs when the capture has none", () => {
  const run = parseCaptureUpload(uploadBody()).capture.scenarios[0];
  const phase = (id: string) => run.requests.find((r) => r.id === id)?.phase;
  assert.equal(phase("a1"), "pre");
  assert.equal(phase("a2"), "pre");
  assert.equal(phase("a3"), "post");
  assert.equal(run.dataLayer[0].phase, "pre");
  assert.equal(run.dataLayer[1].phase, "post");
  // a phase the upload gives is kept
  const b = withCapture((c) => { c.scenarios[0].requests[2].phase = "pre"; });
  assert.equal(parseCaptureUpload(b).capture.scenarios[0].requests.find((r) => r.id === "a3")?.phase, "pre");
  // no marker and no phase: everything is before any consent choice
  const noMarker = parseCaptureUpload(uploadBody({ consentMarkerTs: undefined }));
  assert.ok(noMarker.capture.scenarios[0].requests.every((r) => r.phase === "pre"));
  assert.equal(noMarker.consentMarkerTs, undefined);
});

test("redaction: emails, PII param values, credentials, cookie values, body of non-tracking requests", () => {
  const up = parseCaptureUpload(uploadBody());
  const json = JSON.stringify(up);
  assert.ok(!/john\.doe@|jane@|john%40|john@|jane%40|a%40b\.co|bob@|x@y\.com|me@site\.org/i.test(json), "an email survived");
  assert.ok(!json.includes(CLEAN_COOKIE_VALUE) && !json.includes("fb.1.SECRET"), "cookie value kept");
  assert.ok(!json.includes("secret@") && !json.includes("user:secret"), "URL credentials kept");
  assert.ok(!json.includes("1234567890.1234567890"), "client id kept");
  assert.ok(!json.includes("hashedvalue") && !json.includes("fb.1.1.2"), "Meta user data kept");
  assert.ok(!json.includes("+216 12 345 678") && !json.includes("21612345678"), "phone kept");
  assert.ok(!json.includes("#section-token"), "fragment kept");

  const reqs = up.capture.scenarios[0].requests;
  const a2 = reqs.find((r) => r.id === "a2")!;
  const q = new URL(a2.url).searchParams;
  // keys survive (decoders read them), values are hidden
  assert.equal(q.get("tid"), "G-TEST1");
  assert.equal(q.get("en"), "page_view");
  assert.equal(q.get("cid"), "[redacted]");
  assert.equal(q.get("uid"), "[redacted]");
  assert.equal(q.get("_p"), "999");
  assert.equal(q.get("sid"), "1761300000");
  // a URL nested in dl= is cleaned as a URL
  assert.ok(!decodeURIComponent(q.get("dl") ?? "").includes("john"));
  // GA4 tracking body kept, with PII-like event params hidden and the useful ones intact
  assert.ok(a2.postData?.includes("ep.percent_scrolled=90"));
  assert.ok(a2.postData?.includes("ep.email=%5Bredacted%5D"));
  assert.ok(reqs.find((r) => r.id === "a3")?.postData?.includes("pr1=idMUG1"));
  // the form POST to the site itself loses its body
  assert.equal(reqs.find((r) => r.id === "a4")?.postData, undefined);
  // Meta pixel id and event survive
  const a5 = new URL(reqs.find((r) => r.id === "a5")!.url).searchParams;
  assert.equal(a5.get("id"), "123456789012345");
  assert.equal(a5.get("ev"), "PageView");
  assert.equal(a5.get("eid"), "evt1");
  // cookies: names only, shape fixed
  assert.deepEqual(Object.keys(up.capture.scenarios[0].cookies[0]).sort(), ["domain", "firstParty", "name", "phase", "scenario"]);
  assert.deepEqual(up.capture.scenarios[0].cookies.map((c) => c.phase), ["post", "post"]);
});

test("dataLayer payloads: PII keys hidden, digit runs hashed so equality survives", () => {
  const dl = parseCaptureUpload(uploadBody()).capture.scenarios[0].dataLayer[1].payload as Record<string, any>;
  assert.equal(dl.event, "add_to_cart");
  assert.equal(dl.email, "[redacted]");
  assert.equal(dl.user_id, "[redacted]");
  assert.match(dl.transaction_id, /^\[digits:[0-9a-f]{1,4}\]$/);
  assert.match(dl.note, /^call \[digits:[0-9a-f]+\] now$/);
  assert.equal(dl.nested.contact, "[email]");
  // same transaction id twice hashes the same
  const again = parseCaptureUpload(uploadBody()).capture.scenarios[0].dataLayer[1].payload as Record<string, any>;
  assert.equal(again.transaction_id, dl.transaction_id);
});

test("free text keeps no half of an email when it is cut", () => {
  const long = "x".repeat(300) + " reach me at someone.long.name@example-company.com";
  const out = redactFree(long, 100);
  assert.ok(!out.includes("someone"));
  assert.equal(redactEmails("a%40b.com and c@d.org"), "[email] and [email]");
});

test("redaction is linear on hostile strings", () => {
  const t = Date.now();
  redactEmails("a".repeat(2_000_000));
  redactEmails("a.".repeat(500_000));
  redactEmails("x@".repeat(200_000));
  redactFree("1 ".repeat(100_000), 1000);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test("strict shape: types are checked with a path in the message", () => {
  fails(() => parseCaptureUpload(null), 400, "invalid_capture");
  fails(() => parseCaptureUpload({}), 400, "invalid_capture", /capture: expected an object/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.target = 5; })), 400, "invalid_capture", /capture\.target/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.target = "ftp://x.example/"; })), 400, "invalid_capture", /capture\.target/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.startedAt = "yesterday"; })), 400, "invalid_capture", /startedAt/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.durationMs = -1; })), 400, "invalid_capture", /durationMs/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios = []; })), 400, "invalid_capture", /1 to 3/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios = "x"; })), 400, "invalid_capture", /scenarios/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios[0].scenario = "maybe"; })), 400, "invalid_capture", /scenarios\[0\]\.scenario/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios.push({ ...c.scenarios[0] }); })), 400, "invalid_capture", /twice/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios[0].requests[0].url = 7; })), 400, "invalid_capture", /requests\[0\]\.url/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios[0].requests[0].ts = "soon"; })), 400, "invalid_capture", /requests\[0\]\.ts/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios[0].requests[0].phase = "mid"; })), 400, "invalid_capture", /phase/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios[0].requests[0].postData = { a: 1 }; })), 400, "invalid_capture", /postData/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios[0].requests = {}; })), 400, "invalid_capture", /requests/);
  fails(() => parseCaptureUpload(withCapture((c) => { c.scenarios[0].cookies[0].firstParty = "yes"; })), 400, "invalid_capture", /firstParty/);
  fails(() => parseCaptureUpload(uploadBody({ consentMarkerTs: "now" })), 400, "invalid_capture", /consentMarkerTs/);
  fails(() => parseCaptureUpload(uploadBody({ guidedSteps: [{ name: "!!!", ts: 1 }] })), 400, "invalid_capture", /guidedSteps\[0\]\.name/);
  fails(() => parseCaptureUpload(uploadBody({ guidedSteps: [{ name: "click" }] })), 400, "invalid_capture", /guidedSteps\[0\]\.ts/);
  fails(() => parseCaptureUpload(uploadBody({ guidedSteps: [{ name: "click", ts: 1, conversionType: "party" }] })), 400, "invalid_capture", /conversionType/);
});

test("caps: more than 5,000 requests is 413, exactly 5,000 is fine, long strings are cut", () => {
  fails(() => parseCaptureUpload(bodyWithRequests(UPLOAD_LIMITS.requests + 1)), 413, "payload_too_large", /5001 requests/);
  assert.equal(parseCaptureUpload(bodyWithRequests(UPLOAD_LIMITS.requests)).capture.scenarios[0].requests.length, 5000);
  const b = withCapture((c) => {
    c.scenarios[0].requests[0].postData = "en=x&" + "a".repeat(200_000);
    c.scenarios[0].requests[0].url = "https://www.google-analytics.com/g/collect?v=2&tid=G-TEST1&en=page_view";
    c.scenarios[0].requests[1].url = "https://x.example/?" + "a=b&".repeat(5000);
    c.userAgent = "u".repeat(5000);
    c.scenarios[0].cmp = "c".repeat(5000);
  });
  const up = parseCaptureUpload(b);
  const r = up.capture.scenarios[0].requests;
  assert.ok((r.find((x) => x.id === "a1")?.postData?.length ?? 0) <= UPLOAD_LIMITS.postDataBytes);
  assert.equal(r.find((x) => x.id === "a2"), undefined); // URL over 8,192 chars is dropped
  assert.equal(up.capture.userAgent.length, 300);
  assert.equal(up.capture.scenarios[0].cmp?.length, 80);
});

test("phase handling for a lone accept run: the before part becomes the 'none' run", () => {
  const { capture } = applyUpload(parseCaptureUpload(uploadBody()));
  assert.deepEqual(capture.scenarios.map((s) => s.scenario), ["none", "accept"]);
  const [none, accept] = capture.scenarios;
  assert.equal(none.banner, "not_applicable");
  assert.equal(none.cmp, "Cookiebot");
  assert.ok(none.requests.every((r) => r.scenario === "none" && r.phase === "pre"));
  assert.ok(accept.requests.every((r) => r.scenario === "accept" && r.phase === "post"));
  assert.equal(accept.banner, "clicked");
  assert.deepEqual(none.gtagConsent, { pre: { ad_storage: "granted" } });
  assert.deepEqual(accept.gtagConsent, { post: { analytics_storage: "granted" } });
  assert.equal(capture.region, RECORDED_REGION);
  // a run already labelled "none", or several runs, are left alone
  const none1 = withCapture((c) => { c.scenarios[0].scenario = "none"; });
  assert.deepEqual(applyUpload(parseCaptureUpload(none1)).capture.scenarios.map((s) => s.scenario), ["none"]);
});

test("guided steps become FunnelSteps on matching conversion points", () => {
  const { capture, recording } = applyUpload(parseCaptureUpload(uploadBody()));
  assert.equal(capture.conversionPoints.length, 1);
  const p = capture.conversionPoints[0];
  assert.equal(p.id, "guided-purchase");
  assert.equal(p.type, "purchase");
  assert.equal(p.detectedBy, "extension");
  assert.deepEqual(p.walk.map((s) => [s.name, s.ok, s.scenario]), [
    ["view_item", true, "none"], // before the consent click at 2000
    ["add_to_cart", true, "accept"], // "Add to cart" was normalised
    ["begin_checkout", false, "accept"],
  ]);
  assert.ok(!p.walk.some((s) => /example\.com/.test(s.action)), "email in a step action");
  // stop_before_submit has no type: listed in the report, attached to nothing
  assert.deepEqual(recording.guidedSteps.map((s) => s.name), ["view_item", "add_to_cart", "begin_checkout", "stop_before_submit"]);
  assert.equal(recording.consentMarkerTs, 2000);
  assert.equal(recording.requests, 6);
  assert.equal(recording.source, "extension");
});

test("guided steps attach to an existing point by pointId, hint or page, before a new one is made", () => {
  const point = (id: string, type: string, pageUrl: string) => ({ id, type, pageUrl, label: id, detectedBy: "x", confidence: 0.5, walk: [] });
  const b = withCapture((c) => { c.conversionPoints = [point("cp-a", "lead", "https://shop.example/a"), point("cp-b", "lead", "https://shop.example/b"), point("cp-p", "purchase", "https://shop.example/")]; });
  (b as any).guidedSteps = [
    { name: "form_start", ts: 1, pageUrl: "https://shop.example/b" }, // lead on page b
    { name: "form_start", ts: 2, pointId: "cp-a" }, // explicit
    { name: "click", ts: 3, conversionType: "signup" }, // hint with no signup point: new point
    { name: "add_to_cart", ts: 4 }, // purchase: the only purchase point
  ];
  const { capture } = applyUpload(parseCaptureUpload(b));
  const walk = (id: string) => capture.conversionPoints.find((p) => p.id === id)?.walk.map((s) => s.name);
  assert.deepEqual(walk("cp-b"), ["form_start"]);
  assert.deepEqual(walk("cp-a"), ["form_start"]);
  assert.deepEqual(walk("cp-p"), ["add_to_cart"]);
  assert.deepEqual(walk("guided-signup"), ["click"]);
  assert.equal(capture.conversionPoints.length, 4);
});
