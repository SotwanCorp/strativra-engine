import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "../../types.ts";
import { RULES, runRules } from "./index.ts";
import { capture, cleanSite, consent, hit, leadSite, req, run, shopSite, tagsBeforeConsent } from "./fixtures.ts";
import { CONTRACTS } from "../contracts.ts";
import { hostOf } from "./helpers.ts";

function findings(f: { capture: ReturnType<typeof capture>; hits: ReturnType<typeof hit>[] }): Finding[] {
  return runRules({ capture: f.capture, hits: f.hits, siteHost: hostOf(f.capture.finalUrl) }).findings;
}
const ids = (fs: Finding[]) => fs.map((f) => f.id).sort();
const byId = (fs: Finding[], id: string) => {
  const f = fs.find((x) => x.id === id);
  assert.ok(f, `expected finding ${id}, got ${ids(fs).join(", ")}`);
  return f;
};

const DASH = /[\u2013\u2014]/;

test("(a) clean site has no findings", () => {
  assert.deepEqual(ids(findings(cleanSite())), []);
});

test("(b) tags before consent", () => {
  const fs = findings(tagsBeforeConsent());
  const f = byId(fs, "consent.fires_before_consent");
  assert.equal(f.severity, "critical");
  assert.equal(f.confidence, 3);
  assert.ok(f.reproduced);
  assert.deepEqual(f.vendors.sort(), ["ga4", "meta"]);
  assert.ok(f.evidence.length >= 2 && f.evidence.every((e) => e.ref));
  assert.equal(byId(fs, "consent.cmp_without_consent_mode").severity, "high");
});

test("(c) shop: missing currency, untracked begin_checkout, Meta without eventID", () => {
  const fs = findings(shopSite());
  const eco = byId(fs, "conversion.ecommerce_params_missing");
  assert.equal(eco.severity, "high");
  assert.match(eco.evidence[0].caption, /add_to_cart: currency missing/);
  const funnel = byId(fs, "conversion.funnel_step_untracked");
  assert.equal(funnel.severity, "high");
  assert.match(funnel.why, /begin_checkout/);
  assert.doesNotMatch(funnel.why, /view_item|add_to_cart/);
  const meta = byId(fs, "conversion.meta_no_event_id");
  assert.equal(meta.severity, "medium");
  assert.match(meta.why, /browser half/);
  assert.ok(!fs.some((f) => f.id.startsWith("consent.")));
});

test("(d) lead form without generate_lead or form_start", () => {
  const fs = findings(leadSite());
  const fsm = byId(fs, "conversion.form_start_missing");
  assert.equal(fsm.severity, "low");
  assert.ok(fsm.reproduced);
  const fin = byId(fs, "conversion.final_event_unverified");
  assert.equal(fin.reproduced, false);
  assert.equal(fin.confidence, 1);
  assert.deepEqual(fin.conversionTypes, ["lead"]);
});

test("generate_lead firing during the scan is a false conversion", () => {
  const f = leadSite();
  f.hits.push(hit({ vendor: "ga4", eventName: "generate_lead", accountId: "G-LEAD1", ts: 6100, pageUrl: "https://lead.example/contact", consent: consent("granted") }));
  const fs = findings(f);
  assert.equal(byId(fs, "conversion.fires_without_conversion").severity, "critical");
  assert.ok(!fs.some((x) => x.id === "conversion.final_event_unverified"));
});

test("reject is ignored and Consent Mode v2 keys are missing", () => {
  const site = "https://rej.example/";
  const fs = findings({
    capture: capture({ target: site }),
    hits: [
      hit({ vendor: "google_ads", eventName: "remarketing", accountId: "AW-1", scenario: "reject", phase: "post", ts: 3000, pageUrl: site, consent: consent("granted", { v2: false }) }),
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-R1", scenario: "accept", phase: "post", ts: 3000, pageUrl: site, consent: consent("granted", { v2: false }) }),
    ],
  });
  assert.equal(byId(fs, "consent.granted_after_reject").severity, "critical");
  assert.equal(byId(fs, "consent.mode_v2_missing").severity, "high");
});

test("no banner from EU and banner not clickable", () => {
  const site = "https://nob.example/";
  const fs = findings({
    capture: capture({ target: site, scenarios: [run("none", "not_applicable"), run("accept", "no_banner"), run("reject", "no_banner")] }),
    hits: [hit({ vendor: "meta", eventName: "PageView", scenario: "none", phase: "pre", pageUrl: site })],
  });
  const nb = byId(fs, "consent.no_banner");
  assert.match(nb.why, /No consent banner detected from our EU test location/);
  assert.ok(!fs.some((f) => f.id === "consent.fires_before_consent"));

  const fs2 = findings({
    capture: capture({ target: site, scenarios: [run("none", "not_applicable", { cmp: "OneTrust" }), run("accept", "clicked"), run("reject", "not_clickable")] }),
    hits: [],
  });
  const nt = byId(fs2, "consent.banner_not_testable");
  assert.equal(nt.severity, "low");
  assert.equal(nt.reproduced, false);
});

test("installation: duplicate page_view, gtag + GTM same id, SPA route, UA, no default", () => {
  const site = "https://dup.example/";
  const c = capture({
    target: site,
    pages: [
      { url: site, status: 200, via: "start" },
      { url: "https://dup.example/pricing", status: 200, via: "spa_route" },
    ],
    scenarios: [
      run("none", "not_applicable", { cmp: "Cookiebot" }),
      run("accept", "clicked", {
        cmp: "Cookiebot",
        requests: [
          req({ url: "https://www.googletagmanager.com/gtag/js?id=G-DUP1", pageUrl: site }),
          req({ url: "https://www.googletagmanager.com/gtag/js?id=G-DUP1&cx=c&gtm=45je", pageUrl: site }),
          req({ url: "https://www.google-analytics.com/analytics.js", pageUrl: site }),
        ],
      }),
      run("reject", "clicked", { cmp: "Cookiebot" }),
    ],
  });
  const fs = findings({
    capture: c,
    hits: [
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-DUP1", ts: 1000, pageUrl: site, consent: consent("granted", { defaultState: "unset" }) }),
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-DUP1", ts: 1400, pageUrl: site, consent: consent("granted", { defaultState: "unset" }) }),
    ],
  });
  assert.equal(byId(fs, "install.duplicate_page_view").severity, "high");
  assert.equal(byId(fs, "install.gtag_and_gtm_same_id").confidence, 3);
  assert.equal(byId(fs, "install.spa_missing_page_view").severity, "high");
  assert.equal(byId(fs, "install.ua_legacy").severity, "low");
  assert.equal(byId(fs, "consent.no_default").severity, "medium");
});

test("installation: no GA4, multiple ids", () => {
  const site = "https://none.example/";
  assert.ok(findings({ capture: capture({ target: site }), hits: [] }).some((f) => f.id === "install.no_ga4"));
  const fs = findings({
    capture: capture({ target: site }),
    hits: ["G-A1", "G-B2"].map((id) => hit({ vendor: "ga4", eventName: "page_view", accountId: id, pageUrl: site, consent: consent("granted") })),
  });
  byId(fs, "install.multiple_ga4_ids");
});

test("attribution: payment host and cross-domain without _gl", () => {
  const site = "https://acmeshop.example/";
  const c = capture({
    target: site,
    pages: [
      { url: site, status: 200, via: "start" },
      { url: "https://book.acmeshop.io/start", status: 200, via: "link" },
    ],
    scenarios: [
      run("none", "not_applicable", { cmp: "Cookiebot" }),
      run("accept", "clicked", { cmp: "Cookiebot", requests: [req({ url: "https://calendly.com/acme/30min", resourceType: "sub_frame", pageUrl: site })] }),
      run("reject", "clicked", { cmp: "Cookiebot" }),
    ],
  });
  const fs = findings({ capture: c, hits: [hit({ vendor: "ga4", eventName: "page_view", accountId: "G-X1", pageUrl: site, consent: consent("granted") })] });
  const ref = byId(fs, "attribution.payment_referral_exclusion");
  assert.equal(ref.severity, "medium");
  assert.equal(ref.confidence, 1);
  assert.match(ref.fix.steps.join(" "), /calendly\.com/);
  assert.match(byId(fs, "attribution.cross_domain_no_gl").why, /acmeshop\.io/);
});

test("ads tag without conversion setup, and no conversion point", () => {
  const site = "https://ads.example/";
  const fs = findings({ capture: capture({ target: site }), hits: [hit({ vendor: "google_ads", eventName: "remarketing", accountId: "AW-9", pageUrl: site, consent: consent("granted") })] });
  assert.equal(byId(fs, "conversion.ads_conversion_not_ready").confidence, 1);
  assert.equal(byId(fs, "conversion.no_conversion_point").reproduced, false);
});

test("aborted capture yields no findings", () => {
  const f = tagsBeforeConsent();
  f.capture.aborted = { reason: "bot_protection", detail: "challenge page" };
  assert.deepEqual(findings(f), []);
});

test("every finding is fully filled and follows the copy rules", () => {
  const all = [cleanSite(), tagsBeforeConsent(), shopSite(), leadSite()].flatMap((f) => findings(f));
  assert.ok(all.length > 0);
  for (const f of all) {
    assert.ok(RULES.some((r) => r.id === f.id), `${f.id} is a registered rule id`);
    for (const s of [f.title, f.why, f.fix.summary, ...f.fix.steps, ...f.evidence.map((e) => e.caption)]) {
      assert.doesNotMatch(s, DASH, `${f.id}: no em or en dashes`);
      assert.doesNotMatch(s, /[$€£]\s?\d/, `${f.id}: no prices`);
    }
    assert.ok(f.why.split(/(?<=\.)\s/).length <= 3, `${f.id}: short why`);
    assert.ok(f.fix.steps.length > 0 && f.evidence.length > 0);
    if (f.confidence === 3) assert.ok(f.reproduced, `${f.id}: confidence 3 needs reproduction`);
  }
});

test("contracts cover every conversion type and use no dashes", () => {
  for (const [type, c] of Object.entries(CONTRACTS)) {
    assert.equal(c.type, type);
    assert.ok(c.sources.length > 0);
    for (const n of c.notes) assert.doesNotMatch(n, DASH);
  }
  assert.deepEqual(CONTRACTS.purchase.ga4.requiredParams, ["transaction_id", "currency", "value", "items"]);
});
