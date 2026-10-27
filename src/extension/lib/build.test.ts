import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCapture, phaseAt, resolveStepTs, type RecordingInput } from "./build.ts";
import type { StepRecord } from "./record.ts";

const T0 = 1_700_000_000_000;
const SITE = "https://www.shop.example/";

function input(over: Partial<RecordingInput> = {}): RecordingInput {
  return {
    target: SITE,
    startedAt: T0,
    stoppedAt: T0 + 60_000,
    userAgent: "Mozilla/5.0 Chrome/153",
    visitor: "fresh",
    marker: null,
    requests: [
      { rid: "1", url: SITE, method: "GET", type: "main_frame", ts: T0 + 100, pageUrl: SITE, frameId: 0 },
      { rid: "2", url: "https://www.google-analytics.com/g/collect?v=2&tid=G-AAA&en=page_view&gcs=G100", method: "POST", type: "ping", ts: T0 + 900, pageUrl: SITE, frameId: 0, body: "en=page_view" },
      { rid: "3", url: "https://www.google-analytics.com/g/collect?v=2&tid=G-AAA&en=consent_granted&gcs=G111", method: "POST", type: "ping", ts: T0 + 5000, pageUrl: SITE, frameId: 0 },
      { rid: "4", url: "https://cdn.example.net/lib.js", method: "GET", type: "script", ts: T0 + 400, pageUrl: SITE, frameId: 0 },
      { rid: "5", url: "https://redirect.example/a", method: "GET", type: "image", ts: T0 + 6000, pageUrl: SITE, frameId: 0 },
      { rid: "5", url: "https://redirect.example/b", method: "GET", type: "image", ts: T0 + 6010, pageUrl: SITE, frameId: 0 },
    ],
    errors: [{ rid: "5", error: "net::ERR_BLOCKED_BY_CLIENT", ts: T0 + 6020 }],
    dataLayer: [
      { t: T0 + 200, p: { event: "page_meta" }, pageUrl: SITE },
      { t: T0 + 4900, p: { __gtag: ["consent", "update", { analytics_storage: "granted" }] }, pageUrl: SITE },
    ],
    ics: [
      { t: T0 + 300, ics: { analytics_storage: { default: false, update: null } } },
      { t: T0 + 5200, ics: { analytics_storage: { default: false, update: true } } },
    ],
    droppedPushes: 0,
    navs: [{ ts: T0 + 150, url: SITE, kind: "commit", status: 200 }],
    clicks: [],
    cookies: [
      { ts: T0 + 1000, list: [{ name: "_ga", domain: ".shop.example" }, { name: "sess", domain: "www.shop.example" }] },
      { ts: T0 + 59_000, list: [{ name: "_ga", domain: ".shop.example" }, { name: "consent", domain: "www.shop.example" }, { name: "_ga", domain: ".shop.example" }] },
    ],
    steps: [],
    clientVersion: "0.1.0",
    ...over,
  };
}

test("phaseAt: ts at or after the marker is post (the engine's rule)", () => {
  assert.equal(phaseAt(10, undefined), "pre");
  assert.equal(phaseAt(9, 10), "pre");
  assert.equal(phaseAt(10, 10), "post");
});

test("no marker: one 'none' run, everything pre, banner not applicable", () => {
  const env = buildCapture(input());
  assert.equal(env.capture.scenarios.length, 1);
  const run = env.capture.scenarios[0];
  assert.equal(run.scenario, "none");
  assert.equal(run.banner, "not_applicable");
  assert.ok(run.requests.every((r) => r.phase === "pre" && r.scenario === "none"));
  assert.ok(run.cookies.every((c) => c.phase === "pre"));
  assert.equal(env.consentMarkerTs, undefined);
  assert.equal(env.capture.region, "Recorded in your browser");
  assert.equal(env.capture.durationMs, 60_000);
  assert.equal(env.capture.startedAt, new Date(T0).toISOString());
});

test("marker splits requests, pushes, cookies and gtag consent into pre and post", () => {
  const env = buildCapture(input({ marker: { ts: T0 + 4800, choice: "accept", source: "button" } }));
  const run = env.capture.scenarios[0];
  assert.equal(run.scenario, "accept");
  assert.equal(run.banner, "clicked");
  assert.equal(env.consentMarkerTs, 4800);
  const byUrl = (s: string) => run.requests.find((r) => r.url.includes(s))!;
  assert.equal(byUrl("en=page_view").phase, "pre");
  assert.equal(byUrl("en=page_view").ts, 900);
  assert.equal(byUrl("en=page_view").postData, "en=page_view");
  assert.equal(byUrl("consent_granted").phase, "post");
  assert.deepEqual(run.dataLayer.map((d) => d.phase), ["pre", "post"]);
  assert.deepEqual(run.dataLayer.map((d) => d.ts), [200, 4900]);
  assert.deepEqual(
    run.cookies.map((c) => `${c.phase}:${c.name}@${c.domain}:${c.firstParty}`),
    ["pre:_ga@shop.example:true", "pre:sess@www.shop.example:true", "post:_ga@shop.example:true", "post:consent@www.shop.example:true"],
  );
  assert.equal(run.gtagConsent?.pre?.analytics_storage, "denied");
  assert.equal(run.gtagConsent?.post?.analytics_storage, "granted");
  assert.ok(run.requests.every((r) => r.scenario === "accept"));
});

test("requests: time order, engine resource types, failure on the last redirect hop, ids unique", () => {
  const run = buildCapture(input()).capture.scenarios[0];
  assert.deepEqual(run.requests.map((r) => r.ts), [100, 400, 900, 5000, 6000, 6010]);
  assert.equal(run.requests[0].resourceType, "document");
  assert.equal(run.requests[2].resourceType, "ping");
  assert.equal(run.requests.find((r) => r.url.endsWith("/a"))!.failed, undefined);
  assert.equal(run.requests.find((r) => r.url.endsWith("/b"))!.failed, "net::ERR_BLOCKED_BY_CLIENT");
  assert.equal(new Set(run.requests.map((r) => r.id)).size, run.requests.length);
  assert.ok(run.requests.every((r) => !("headers" in r)));
});

test("pages come from top-level navigations with status and via", () => {
  const env = buildCapture(
    input({
      navs: [
        { ts: T0 + 150, url: SITE, kind: "commit", status: 200 },
        { ts: T0 + 8000, url: `${SITE}cart`, kind: "commit", status: 200 },
        { ts: T0 + 9000, url: `${SITE}cart#/step2`, kind: "spa" },
      ],
    }),
  );
  assert.deepEqual(env.capture.pages.map((p) => `${p.via} ${p.status}`), ["start 200", "link 200", "spa_route null"]);
  assert.equal(env.capture.finalUrl, SITE);
});

test("guided steps: visitor step first, step time from the last page load or click, skipped and stopped", () => {
  const steps: StepRecord[] = [
    { id: "view_item", name: "view_item", action: "Opened a product page", at: "page_load", conversionType: "purchase", status: "done", doneTs: T0 + 12_000 },
    { id: "add_to_cart", name: "add_to_cart", action: "Added a product to the cart", at: "click", conversionType: "purchase", status: "done", doneTs: T0 + 20_000 },
    { id: "begin_checkout", name: "begin_checkout", action: "Went to checkout", at: "any", conversionType: "purchase", status: "skipped", doneTs: T0 + 25_000 },
    { id: "stop", name: "stopped", action: "Stopped before paying", at: "now", status: "stopped", doneTs: T0 + 30_000 },
  ];
  const env = buildCapture(
    input({
      visitor: "returning",
      steps,
      clicks: [T0 + 9000, T0 + 15_000, T0 + 16_000],
      navs: [
        { ts: T0 + 150, url: SITE, kind: "commit" },
        { ts: T0 + 10_000, url: `${SITE}p/mug`, kind: "commit" },
      ],
    }),
  );
  const g = env.guidedSteps;
  assert.equal(g[0].name, "returning_visitor");
  assert.equal(g[0].ts, 0);
  assert.equal(g[0].conversionType, undefined);
  assert.deepEqual(
    g.slice(1).map((s) => [s.name, s.ts, s.ok, s.conversionType ?? null, s.pageUrl]),
    [
      ["view_item", 10_000, true, "purchase", `${SITE}p/mug`],
      ["add_to_cart", 16_000, true, "purchase", `${SITE}p/mug`],
      ["begin_checkout", 25_000, false, "purchase", `${SITE}p/mug`],
      ["stopped", 30_000, true, null, `${SITE}p/mug`],
    ],
  );
  assert.match(g[3].action, /^Skipped: /);
  assert.equal(env.capture.conversionPoints.length, 0, "the engine maps guided steps onto points");
  assert.equal(env.visitor, "returning");
  assert.equal(buildCapture(input()).guidedSteps[0].name, "fresh_visitor");
});

test("resolveStepTs falls back to the press when nothing happened in the window", () => {
  const s: StepRecord = { id: "form_start", name: "form_start", action: "x", at: "click", status: "done", doneTs: 5000 };
  assert.equal(resolveStepTs(s, 1000, [500], []), 5000);
  assert.equal(resolveStepTs(s, 1000, [1500, 4000, 6000], []), 4000);
  assert.equal(resolveStepTs({ ...s, at: "page_load" }, 1000, [3000], [{ ts: 2000, url: "u", kind: "commit" }]), 2000);
  assert.equal(resolveStepTs({ ...s, at: "page_load" }, 1000, [3000], []), 3000);
  assert.equal(resolveStepTs({ ...s, at: "any" }, 1000, [3000], [{ ts: 3500, url: "u", kind: "commit" }]), 3500);
  assert.equal(resolveStepTs({ ...s, at: "now" }, 1000, [3000], []), 5000);
});

test("dropped dataLayer pushes are noted on the run", () => {
  const env = buildCapture(input({ droppedPushes: 3 }));
  assert.match(env.capture.scenarios[0].errors[0], /3 pushes over the cap/);
});
