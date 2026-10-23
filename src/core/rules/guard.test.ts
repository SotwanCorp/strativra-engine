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
