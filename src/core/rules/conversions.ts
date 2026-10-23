import type { ConversionPoint, ConversionType, DecodedHit, Evidence, FunnelStep, Severity } from "../../types.ts";
import { CONTRACTS, FINAL_GA4_EVENTS, FINAL_META_EVENTS, GA4_AUTOMATIC_EVENTS, GA4_ECOMMERCE_EVENTS } from "../contracts.ts";
import type { Rule, RuleContext } from "./types.ts";
import { AD_VENDORS, hitEvidence, note, sampleHits, uniq, vendorsOf } from "./helpers.ts";

/** Window around a walked step in which its event must show up. */
const STEP_BEFORE_MS = 1000;
const STEP_AFTER_MS = 8000;

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];
function worst(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

function ga4(ctx: RuleContext): DecodedHit[] {
  return ctx.hits.filter((h) => h.vendor === "ga4");
}

function matchesStep(h: DecodedHit, step: FunnelStep, names: string[]): boolean {
  if (h.vendor !== "ga4" || h.scenario !== step.scenario) return false;
  if (h.ts < step.ts - STEP_BEFORE_MS || h.ts > step.ts + STEP_AFTER_MS) return false;
  if (names.includes("*")) return !GA4_AUTOMATIC_EVENTS.includes(h.eventName);
  return names.includes(h.eventName);
}

function stepEvidence(p: ConversionPoint, s: FunnelStep, expected: string[]): Evidence {
  return note(`${p.label}: "${s.action}" sent no ${expected.includes("*") ? "GA4 event" : expected.join(" or ")}`, {
    point: p.id,
    step: s.name,
    page: s.pageUrl,
    scenario: s.scenario,
  });
}

/** Read a GA4 param under its decoded name or its raw protocol name. */
function param(h: DecodedHit, ...names: string[]): string | number | unknown[] | undefined {
  for (const n of names) if (h.params[n] !== undefined) return h.params[n];
  return undefined;
}

function itemsOf(h: DecodedHit): unknown[] | undefined {
  const items = param(h, "items");
  if (Array.isArray(items)) return items;
  const pr = Object.keys(h.params).filter((k) => /^pr\d+$/.test(k));
  return pr.length ? pr.map((k) => h.params[k]) : undefined;
}

function itemHasId(item: unknown): boolean {
  if (typeof item === "string") return /(^|~)(id|nm)/.test(item);
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    return !!(o.item_id ?? o.item_name ?? o.id ?? o.nm);
  }
  return false;
}

export function ecommerceProblems(h: DecodedHit): string[] {
  const out: string[] = [];
  const currency = param(h, "currency", "cu");
  const value = param(h, "value");
  const items = itemsOf(h);
  if (currency === undefined || currency === "") out.push("currency missing");
  if (value === undefined || value === "") out.push("value missing");
  else if (typeof value !== "number") out.push("value sent as text, not a number");
  if (!items || items.length === 0) out.push("items missing");
  else if (!items.every(itemHasId)) out.push("items without item_id or item_name");
  if (h.eventName === "purchase" && !param(h, "transaction_id", "ep.transaction_id")) out.push("transaction_id missing");
  return out;
}

const firesWithoutConversion: Rule = {
  id: "conversion.fires_without_conversion",
  run(ctx) {
    const bad = ctx.hits.filter(
      (h) =>
        (h.vendor === "ga4" && FINAL_GA4_EVENTS.includes(h.eventName)) ||
        (h.vendor === "meta" && FINAL_META_EVENTS.includes(h.eventName)) ||
        ((h.vendor === "google_ads" || h.vendor === "floodlight") && h.eventName === "conversion" && !!h.conversionLabel),
    );
    if (bad.length === 0) return [];
    const types = uniq(
      bad.map((h): ConversionType => {
        if (h.eventName === "purchase" || h.eventName === "Purchase") return "purchase";
        if (h.eventName === "sign_up" || h.eventName === "CompleteRegistration") return "signup";
        if (h.eventName === "Schedule") return "booking";
        return "lead";
      }),
    );
    return [
      {
        id: this.id,
        title: "A conversion fires when nobody converted",
        severity: "critical",
        why: "We never submit forms or pay, yet a conversion event fired. Your reports and ad bidding count conversions that did not happen.",
        conversionTypes: types,
        vendors: vendorsOf(bad),
        impact: 5,
        confidence: 3,
        reach: 2,
        effort: 2,
        reproduced: true,
        evidence: sampleHits(bad).map((h) => hitEvidence(h, `${h.eventName} fired without a real conversion`, h.conversionLabel ? { label: h.conversionLabel } : undefined)),
        fix: {
          summary: "Fire conversions only on a confirmed success, never on clicks or page loads.",
          steps: [
            "Find the trigger of each event listed: a click, a form submit attempt or a page view.",
            "Move it to the success signal: thank-you page, success callback or confirmed order.",
            "Protect thank-you pages against reloads, for example with a unique transaction_id.",
          ],
        },
      },
    ];
  },
};

const funnelStepUntracked: Rule = {
  id: "conversion.funnel_step_untracked",
  appliesTo: (ctx) => ga4(ctx).length > 0,
  run(ctx) {
    const hits = ga4(ctx);
    const misses: Array<{ p: ConversionPoint; s: FunnelStep; expected: string[] }> = [];
    for (const p of ctx.capture.conversionPoints) {
      const contract = CONTRACTS[p.type];
      for (const s of p.walk) {
        if (!s.ok) continue;
        const entry = contract.funnel.find((f) => f.step === s.name && f.required);
        if (!entry) continue;
        if (!hits.some((h) => matchesStep(h, s, entry.ga4))) misses.push({ p, s, expected: entry.ga4 });
      }
    }
    if (misses.length === 0) return [];
    const types = uniq(misses.map((m) => m.p.type));
    let severity: Severity = "low";
    let impact: 1 | 2 | 3 | 4 | 5 = 2;
    for (const t of types) {
      if (t === "purchase") {
        severity = worst(severity, "high");
        impact = 4;
      } else if (t !== "download") {
        severity = worst(severity, "medium");
        if (impact < 3) impact = 3;
      }
    }
    const steps = uniq(misses.map((m) => m.s.name));
    return [
      {
        id: this.id,
        title: types.includes("purchase") ? "Shop funnel steps are not tracked" : "Conversion clicks are not tracked",
        severity,
        why: `We did ${steps.join(", ")} on the site and GA4 recorded nothing for it. You cannot see where people drop off.`,
        conversionTypes: types,
        vendors: ["ga4"],
        impact,
        confidence: 3,
        reach: types.includes("purchase") ? 3 : 2,
        effort: 2,
        reproduced: true,
        evidence: misses.slice(0, 5).map((m) => stepEvidence(m.p, m.s, m.expected)),
        fix: {
          summary: "Send the expected GA4 event at each step.",
          steps: [
            ...uniq(misses.map((m) => (m.expected.includes("*") ? `On ${m.s.name} (${m.p.label}), send a click event that names the channel.` : `On ${m.s.name}, send ${m.expected.join(" or ")}.`))),
            "Test each step in GTM Preview and GA4 DebugView.",
          ],
        },
      },
    ];
  },
};

const ecommerceParamsMissing: Rule = {
  id: "conversion.ecommerce_params_missing",
  run(ctx) {
    const bad = ga4(ctx)
      .filter((h) => GA4_ECOMMERCE_EVENTS.includes(h.eventName) && h.eventName !== "view_item_list" && h.eventName !== "select_item")
      .map((h) => ({ h, problems: ecommerceProblems(h) }))
      .filter((x) => x.problems.length > 0);
    if (bad.length === 0) return [];
    const purchase = bad.some((x) => x.h.eventName === "purchase");
    const allProblems = uniq(bad.flatMap((x) => x.problems));
    const seen = new Set<string>();
    const samples = bad.filter((x) => (seen.has(x.h.eventName) ? false : (seen.add(x.h.eventName), true))).slice(0, 5);
    return [
      {
        id: this.id,
        title: purchase ? "Purchase data is incomplete" : "Shop events are missing value data",
        severity: purchase ? "critical" : "high",
        why: purchase
          ? "Purchase events lack fields GA4 and Google Ads need, so revenue is wrong or missing."
          : `Shop events have problems: ${allProblems.join(", ")}. GA4 drops the value without a currency, so the funnel shows no money.`,
        conversionTypes: ["purchase"],
        vendors: ["ga4"],
        impact: purchase ? 5 : 4,
        confidence: 3,
        reach: 3,
        effort: 2,
        reproduced: true,
        evidence: samples.map((x) => hitEvidence(x.h, `${x.h.eventName}: ${x.problems.join(", ")}`)),
        fix: {
          summary: "Send currency, a numeric value and items with item_id or item_name on every shop event.",
          steps: [
            "Check the ecommerce object your shop pushes to the dataLayer.",
            "Map currency, value and items in the GA4 event tags, or turn on 'Send ecommerce data'.",
            "Send value as a number, not as text.",
            "Check one full funnel in GA4 DebugView.",
          ],
        },
      },
    ];
  },
};

const META_CONVERSION_EVENTS = ["ViewContent", "AddToCart", "InitiateCheckout", "AddPaymentInfo", "Contact", "Search", ...FINAL_META_EVENTS];

const metaNoEventId: Rule = {
  id: "conversion.meta_no_event_id",
  run(ctx) {
    const bad = ctx.hits.filter((h) => h.vendor === "meta" && META_CONVERSION_EVENTS.includes(h.eventName) && !h.eventId);
    if (bad.length === 0) return [];
    const types = uniq(
      bad.map((h): ConversionType => {
        if (["ViewContent", "AddToCart", "InitiateCheckout", "AddPaymentInfo", "Purchase"].includes(h.eventName)) return "purchase";
        if (h.eventName === "Schedule") return "booking";
        if (h.eventName === "CompleteRegistration") return "signup";
        if (h.eventName === "Contact") return "contact_click";
        return "lead";
      }),
    );
    return [
      {
        id: this.id,
        title: "Meta events have no event ID for deduplication",
        severity: "medium",
        why: "Browser Meta events carry no eventID. If you also send server events (Conversions API), Meta cannot match them and may count twice. We only see the browser half.",
        conversionTypes: types,
        vendors: ["meta"],
        impact: 3,
        confidence: 2,
        reach: 2,
        effort: 2,
        reproduced: true,
        evidence: sampleHits(bad).map((h) => hitEvidence(h, `Meta ${h.eventName} without eventID`)),
        fix: {
          summary: "Send the same eventID on the browser event and the matching server event.",
          steps: [
            "Generate one ID per event in the dataLayer push.",
            "Pass it as eventID on the Pixel and as event_id in the Conversions API.",
            "Check deduplication in Meta Events Manager.",
          ],
        },
      },
    ];
  },
};

const adsConversionNotReady: Rule = {
  id: "conversion.ads_conversion_not_ready",
  appliesTo: (ctx) => ctx.hits.some((h) => h.vendor === "google_ads"),
  run(ctx) {
    const ads = ctx.hits.filter((h) => h.vendor === "google_ads");
    if (ads.some((h) => !!h.conversionLabel)) return [];
    const accept = ctx.capture.scenarios.find((s) => s.scenario === "accept");
    if (accept?.cookies.some((c) => c.name === "_gcl_au")) return [];
    return [
      {
        id: this.id,
        title: "Google Ads tag found, but no conversion setup seen",
        severity: "medium",
        why: "The Google Ads tag loads, but we saw no conversion linker cookie and no conversion label. Ads may not be able to tie conversions to clicks. We cannot see your Ads account from outside.",
        conversionTypes: uniq(ctx.capture.conversionPoints.map((p) => p.type)),
        vendors: ["google_ads"],
        impact: 3,
        confidence: 1,
        reach: 2,
        effort: 2,
        reproduced: false,
        evidence: [...sampleHits(ads, 2).map((h) => hitEvidence(h, "Google Ads hit")), note("No _gcl_au cookie after accepting cookies.")],
        fix: {
          summary: "Add a Conversion Linker and a Google Ads conversion tag on the success step.",
          steps: ["Add the Conversion Linker tag on all pages in GTM.", "Add a Google Ads conversion tag on each real success.", "Check the conversion action status in Google Ads."],
        },
      },
    ];
  },
};

const noConversionPoint: Rule = {
  id: "conversion.no_conversion_point",
  appliesTo: (ctx) => ctx.capture.conversionPoints.length === 0,
  run(ctx) {
    const ads = ctx.hits.filter((h) => AD_VENDORS.includes(h.vendor));
    if (ads.length === 0) return [];
    return [
      {
        id: this.id,
        title: "Ad pixels run, but we found no conversion point",
        severity: "medium",
        why: "You pay for ads that track visitors, but on the pages we visited we found no form, checkout, booking or contact link to test. Ads may be optimising without a goal.",
        conversionTypes: [],
        vendors: vendorsOf(ads),
        impact: 3,
        confidence: 1,
        reach: 2,
        effort: 2,
        reproduced: false,
        evidence: [note(`Pages visited: ${ctx.capture.pages.length}. Conversion points found: 0.`), ...sampleHits(ads, 3).map((h) => hitEvidence(h, `${h.vendor} active`))],
        fix: {
          summary: "Confirm what counts as a conversion and track it on every ad platform.",
          steps: ["List the actions that make you money: order, form, booking, call.", "Track each one in GA4 and in every ad platform you pay for."],
        },
      },
    ];
  },
};

const formStartMissing: Rule = {
  id: "conversion.form_start_missing",
  appliesTo: (ctx) => ga4(ctx).length > 0,
  run(ctx) {
    const hits = ga4(ctx);
    const misses: Array<{ p: ConversionPoint; s: FunnelStep }> = [];
    for (const p of ctx.capture.conversionPoints) {
      if (p.type !== "lead" && p.type !== "signup") continue;
      for (const s of p.walk) {
        if (!s.ok || s.name !== "form_start") continue;
        if (!hits.some((h) => matchesStep(h, s, ["form_start"]))) misses.push({ p, s });
      }
    }
    if (misses.length === 0) return [];
    return [
      {
        id: this.id,
        title: "Starting a form is not tracked",
        severity: "low",
        why: "We clicked into a form field and GA4 sent no form_start. You cannot see how many people start but never finish.",
        conversionTypes: uniq(misses.map((m) => m.p.type)),
        vendors: ["ga4"],
        impact: 2,
        confidence: 3,
        reach: 2,
        effort: 1,
        reproduced: true,
        evidence: misses.slice(0, 3).map((m) => stepEvidence(m.p, m.s, ["form_start"])),
        fix: {
          summary: "Turn on form interactions in GA4 enhanced measurement, or add a form_start tag in GTM.",
          steps: ["Enable 'Form interactions' in the GA4 data stream settings.", "If your form builder hides it, push form_start to the dataLayer on first focus."],
        },
      },
    ];
  },
};

const FINAL_TYPES: ConversionType[] = ["lead", "booking", "signup"];

const finalEventUnverified: Rule = {
  id: "conversion.final_event_unverified",
  appliesTo: (ctx) => ctx.capture.conversionPoints.some((p) => FINAL_TYPES.includes(p.type)),
  run(ctx) {
    const types = uniq(ctx.capture.conversionPoints.filter((p) => FINAL_TYPES.includes(p.type)).map((p) => p.type));
    const missing = types.filter((t) => {
      const c = CONTRACTS[t];
      return !ctx.hits.some(
        (h) =>
          (h.vendor === "ga4" && c.ga4.events.includes(h.eventName)) ||
          (h.vendor === "meta" && (c.meta?.events ?? []).includes(h.eventName)) ||
          (h.vendor === "google_ads" && !!h.conversionLabel),
      );
    });
    if (missing.length === 0) return [];
    const points = ctx.capture.conversionPoints.filter((p) => missing.includes(p.type));
    const expected = missing.map((t) => `${t}: ${CONTRACTS[t].ga4.events.join(" or ")}`);
    const iframe = points.some((p) => p.type === "booking");
    return [
      {
        id: this.id,
        title: "We could not confirm your main conversion is tracked",
        severity: "medium",
        why: `We never submit, so we cannot see the final event fire. We also saw no sign of ${missing.map((t) => CONTRACTS[t].ga4.events[0]).join(" or ")} anywhere on the site.`,
        conversionTypes: missing,
        vendors: ["ga4"],
        impact: 4,
        confidence: 1,
        reach: 2,
        effort: 2,
        reproduced: false,
        evidence: [
          ...points.slice(0, 3).map((p) => note(`${p.label} on ${p.pageUrl}`, { point: p.id, detectedBy: p.detectedBy })),
          note("Expected events", expected),
        ],
        fix: {
          summary: "Fire the conversion event once, on the confirmed success only.",
          steps: [
            "Lead: send generate_lead with value and currency on the thank-you page or success callback.",
            ...(iframe ? ["Booking: add a postMessage listener for the scheduler iframe and push one booking event per confirmed booking."] : []),
            "Mirror it in Google Ads and Meta with the same trigger.",
            "Make one real test submission and check it arrives once in each tool.",
          ],
        },
      },
    ];
  },
};

export const CONVERSION_RULES: Rule[] = [
  firesWithoutConversion,
  ecommerceParamsMissing,
  funnelStepUntracked,
  finalEventUnverified,
  metaNoEventId,
  adsConversionNotReady,
  noConversionPoint,
  formStartMissing,
];
