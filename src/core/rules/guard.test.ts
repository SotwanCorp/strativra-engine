import { test } from "node:test";
import assert from "node:assert/strict";
import { runRules } from "./index.ts";
import { capture, leadSite, req, run } from "./fixtures.ts";

test("a tag library that failed to load replaces 'not tracked' findings with one honest finding", () => {
  const c = capture({
    target: "https://example.test/",
    pages: [{ url: "https://example.test/", status: 200, via: "start" }],
    scenarios: [
      run("none", "not_applicable"),
      run("accept", "clicked", {
        requests: [req({ url: "https://www.googletagmanager.com/gtm.js?id=GTM-TEST", failed: "net::ERR_TUNNEL_CONNECTION_FAILED" })],
      }),
      run("reject", "clicked"),
    ],
  });
  const ids = runRules({ capture: c, hits: [], siteHost: "example.test" }).findings.map((f) => f.id);
  assert.ok(!ids.includes("install.no_ga4"));
  assert.ok(ids.includes("scan.tag_library_failed"));
});

test("without a failed library, absence findings stay", () => {
  const { capture: c, hits } = leadSite();
  const ids = runRules({ capture: c, hits, siteHost: "lead.test" }).findings.map((f) => f.id);
  assert.ok(!ids.includes("scan.tag_library_failed"));
  assert.ok(ids.includes("conversion.form_start_missing"));
});

test("a step whose dataLayer event was pushed but not seen in GA4 is unverified, not 'not tracked'", async () => {
  const { leadSite: _l, ...fx } = await import("./fixtures.ts");
  const point = { id: "cc1", type: "contact_click" as const, pageUrl: "https://example.test/", label: "Email link", detectedBy: "generic", confidence: 0.9, walk: [{ name: "click", action: "clicked email link", ok: true, pageUrl: "https://example.test/", ts: 1000, scenario: "accept" as const }] };
  const c = fx.capture({
    target: "https://example.test/",
    pages: [{ url: "https://example.test/", status: 200, via: "start" }],
    conversionPoints: [point],
    scenarios: [
      fx.run("none", "not_applicable"),
      fx.run("accept", "clicked", { dataLayer: [{ scenario: "accept", phase: "post", ts: 1200, pageUrl: "https://example.test/", payload: { event: "email_click" } }] }),
      fx.run("reject", "clicked"),
    ],
  });
  const hits = [fx.hit({ vendor: "ga4", eventName: "page_view", scenario: "accept", phase: "post", ts: 500, pageUrl: "https://example.test/" })];
  const ids = runRules({ capture: c, hits, siteHost: "example.test" }).findings.map((f) => f.id);
  assert.ok(!ids.includes("conversion.funnel_step_untracked"));
  assert.ok(ids.includes("conversion.datalayer_event_no_hit"));
});
