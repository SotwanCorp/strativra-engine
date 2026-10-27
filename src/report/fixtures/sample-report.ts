import type { Finding, Report, Severity } from "../../types.ts";

/** Fictional site. Not a real brand, not a client. */
const findings: Finding[] = [
  {
    id: "consent.fires_before_consent",
    title: "Ads and analytics tags fire before consent",
    severity: "critical",
    why: "Visitors who have not chosen yet are already tracked. This is a legal exposure and it skews your consent rates.",
    conversionTypes: [],
    vendors: ["ga4", "meta"],
    impact: 5, confidence: 3, reach: 3, effort: 2, reproduced: true,
    evidence: [
      { kind: "hit", caption: "GA4 page_view sent before any banner click", ref: "req-014",
        data: { host: "www.google-analytics.com", path: "/g/collect", tid: "G-TEST0000", en: "page_view", gcs: "G111", phase: "pre" } },
      { kind: "hit", caption: "Meta PageView sent before any banner click", ref: "req-021",
        data: { host: "www.facebook.com", path: "/tr", id: "000000000000000", ev: "PageView", phase: "pre" } },
      { kind: "screenshot", caption: "Banner still open while tags fire", ref: "shots/consent-none.png" },
    ],
    fix: {
      summary: "Set consent defaults to denied and gate the tags on consent state.",
      steps: [
        "Add a Consent Mode default of denied for all four consent types, before the GTM container loads.",
        "Require ad_storage and analytics_storage in the Meta and Ads tags' consent settings.",
        "Re-test with the banner closed, accepted and rejected.",
      ],
    },
  },
  {
    id: "purchase.missing_transaction_id",
    title: "Purchase event has no transaction_id",
    severity: "high",
    why: "Without it GA4 cannot deduplicate, so a reload of the thank-you page counts the order twice.",
    conversionTypes: ["purchase"], vendors: ["ga4"],
    impact: 5, confidence: 3, reach: 2, effort: 1, reproduced: true,
    evidence: [
      { kind: "datalayer", caption: "purchase push on the order confirmation", ref: "dl-007",
        data: { event: "purchase", currency: "EUR", value: 49.9, items: [{ item_id: "sku-1" }] } },
    ],
    fix: { summary: "Push the order id as transaction_id.", steps: ["Add transaction_id to the purchase dataLayer push.", "Map it in the GA4 event tag."] },
  },
  {
    id: "meta.no_event_id_dedup",
    title: "Meta events carry no event ID",
    severity: "high",
    why: "If you add the Conversions API later, Meta cannot match browser and server events and will count both.",
    conversionTypes: ["purchase", "lead"], vendors: ["meta"],
    impact: 4, confidence: 3, reach: 2, effort: 2, reproduced: true,
    evidence: [{ kind: "hit", caption: "Meta Purchase without eid", ref: "req-044", data: { ev: "Purchase", id: "000000000000000", eid: "" } }],
    fix: { summary: "Generate one event ID per action and send it from both sides.", steps: ["Create the ID when the action happens.", "Pass it as eventID in the pixel call."] },
  },
  {
    id: "gtm.duplicate_ga4_config",
    title: "GA4 is configured twice on the same page",
    severity: "medium",
    why: "Two config tags double page views and inflate sessions.",
    conversionTypes: [], vendors: ["ga4", "gtm"],
    impact: 3, confidence: 3, reach: 3, effort: 1, reproduced: true,
    evidence: [{ kind: "note", caption: "Two page_view hits within 40 ms", data: { count: 2, tid: "G-TEST0000", gapMs: 38 } }],
    fix: { summary: "Remove the hard-coded gtag snippet or the GTM config tag.", steps: ["Find the duplicate in the theme.", "Keep one config source."] },
  },
  {
    id: "gads.no_enhanced_conversions",
    title: "Google Ads conversion sent without enhanced conversions",
    severity: "medium",
    why: "Fewer conversions are matched, so bidding learns from less data.",
    conversionTypes: ["purchase"], vendors: ["google_ads"],
    impact: 3, confidence: 2, reach: 2, effort: 2, reproduced: true,
    evidence: [{ kind: "hit", caption: "Conversion hit without user data", ref: "req-051", data: { id: "AW-000000000", label: "abc123", em: "absent" } }],
    fix: { summary: "Turn on enhanced conversions with hashed first-party data.", steps: ["Enable it in the Ads conversion action.", "Send hashed email from the confirmation page."] },
  },
  {
    id: "lead.fires_on_click",
    title: "Lead event fires on button click, not on success",
    severity: "medium",
    why: "Failed or invalid submissions count as leads.",
    conversionTypes: ["lead"], vendors: ["ga4"],
    impact: 3, confidence: 2, reach: 2, effort: 2, reproduced: false,
    evidence: [{ kind: "note", caption: "generate_lead seen before any success state" }],
    fix: { summary: "Fire the event from the success callback.", steps: ["Move the trigger to the form success event."] },
  },
  {
    id: "consent.gcd_unknown_letters",
    title: "Consent signal contains letters we cannot map",
    severity: "low",
    why: "Google does not publish the full code list, so part of the consent state is unknown.",
    conversionTypes: [], vendors: ["ga4"],
    impact: 1, confidence: 2, reach: 1, effort: 1, reproduced: true,
    evidence: [{ kind: "hit", caption: "Raw gcd value", data: { gcd: "13l3l3l3l1" } }],
    fix: { summary: "Verify the state in Tag Assistant.", steps: ["Open Tag Assistant and compare consent states."] },
  },
  {
    id: "sgtm.browser_half_only",
    title: "A first-party tagging endpoint is present, but only half is visible",
    severity: "low",
    why: "From outside we see the browser side only. The server side needs a look from the inside.",
    conversionTypes: [], vendors: ["sgtm"],
    impact: 1, confidence: 1, reach: 1, effort: 1, reproduced: true,
    evidence: [{ kind: "hit", caption: "Hit to the site's own tagging domain", data: { host: "t.example-shop.test", path: "/g/collect" } }],
    fix: { summary: "Review the server container.", steps: ["Compare server logs with browser hits."] },
  },
];

const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
for (const f of findings) counts[f.severity]++;

export const sampleReport: Report = {
  id: "sample-0001",
  kind: "free",
  target: "example-shop.test",
  finalUrl: "https://example-shop.test/",
  generatedAt: "2026-10-23T09:30:00.000Z",
  region: "EU (Germany)",
  stack: [
    { vendor: "platform", name: "Example Platform", ids: [], source: "html" },
    { vendor: "cmp", name: "Example CMP", ids: [], source: "global" },
    { vendor: "gtm", name: "Google Tag Manager", ids: ["GTM-TEST123"], source: "network" },
    { vendor: "sgtm", name: "Server-side tagging", ids: ["t.example-shop.test"], source: "network", firstParty: true },
    { vendor: "ga4", name: "GA4", ids: ["G-TEST0000"], source: "network" },
    { vendor: "google_ads", name: "Google Ads", ids: ["AW-000000000"], source: "network" },
    { vendor: "meta", name: "Meta Pixel", ids: ["000000000000000"], source: "network" },
    { vendor: "tiktok", name: "TikTok Pixel", ids: ["TESTPIXEL01"], source: "network" },
  ],
  conversions: [
    { type: "purchase", points: ["cp1"], status: "broken", summary: "Purchase fires, but with no transaction_id." },
    { type: "lead", points: ["cp2"], status: "partial", summary: "Lead fires, possibly on click instead of success." },
    { type: "contact_click", points: ["cp3"], status: "ok", summary: "Phone and email clicks are tracked." },
    { type: "booking", points: [], status: "not_tracked", summary: "No booking event was seen." },
    { type: "download", points: [], status: "not_testable", summary: "No download found to test safely." },
  ],
  findings,
  open: findings.slice(0, 3).map((f) => f.id),
  counts,
  rankNotes: {
    "consent.fires_before_consent": "Highest impact, reproduced on every page, one config fix.",
    "purchase.missing_transaction_id": "Affects every order, cheapest fix.",
    "meta.no_event_id_dedup": "Blocks clean server-side events later.",
  },
  scan: { pages: 6, durationMs: 48000, banner: { none: "not_applicable", accept: "clicked", reject: "clicked" } },
};

export const sampleReconciliation = [
  { conversion: "Purchase", system: "Shop backend vs GA4", truth: 412, platform: 355 },
  { conversion: "Purchase", system: "Shop backend vs Meta", truth: 412, platform: 468 },
  { conversion: "Lead", system: "CRM vs Google Ads", truth: 87, platform: 61 },
];
