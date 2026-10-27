/**
 * Hand-written Capture + DecodedHit fixtures for rule, rank and report tests.
 * Not a test file itself (no .test.ts suffix).
 */
import type {
  BannerOutcome,
  Capture,
  CapturedRequest,
  ConsentKey,
  ConsentPhase,
  ConsentSignals,
  ConsentValue,
  ConversionPoint,
  CookieRecord,
  DecodedHit,
  Scenario,
  ScenarioRun,
} from "../../types.ts";

let n = 0;
const nextId = () => `r${++n}`;

const KEYS: ConsentKey[] = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"];

export function consent(state: ConsentValue, opts: { v2?: boolean; defaultState?: ConsentValue } = {}): ConsentSignals {
  const v2 = opts.v2 ?? true;
  const keys: ConsentSignals["keys"] = {};
  for (const k of v2 ? KEYS : KEYS.slice(0, 2)) keys[k] = { default: opts.defaultState ?? "denied", update: state, current: state };
  const g = state === "granted" ? "1" : "0";
  return v2
    ? { raw: { gcs: `G1${g}${g}`, gcd: state === "granted" ? "13r3r3r3r5" : "13q3q3q3q5" }, keys, unknownLetters: [] }
    : { raw: { gcs: `G1${g}${g}` }, keys, unknownLetters: [] };
}

export function hit(p: Partial<DecodedHit> & Pick<DecodedHit, "vendor" | "eventName">): DecodedHit {
  return {
    requestId: p.requestId ?? nextId(),
    scenario: p.scenario ?? "accept",
    phase: p.phase ?? "post",
    ts: p.ts ?? 1000,
    pageUrl: p.pageUrl ?? "https://shop.example/",
    params: p.params ?? {},
    firstParty: p.firstParty ?? false,
    ...p,
  };
}

export function req(p: Partial<CapturedRequest> & Pick<CapturedRequest, "url">): CapturedRequest {
  return {
    id: p.id ?? nextId(),
    scenario: p.scenario ?? "accept",
    phase: p.phase ?? "post",
    ts: p.ts ?? 500,
    pageUrl: p.pageUrl ?? "https://shop.example/",
    method: p.method ?? "GET",
    resourceType: p.resourceType ?? "script",
    ...p,
  };
}

export function run(scenario: Scenario, banner: BannerOutcome, extra: Partial<ScenarioRun> = {}): ScenarioRun {
  return { scenario, banner, requests: [], dataLayer: [], cookies: [], screenshots: [], errors: [], ...extra };
}

export function capture(p: Partial<Capture> & { target: string }): Capture {
  return {
    finalUrl: p.target,
    region: "EU (Germany)",
    startedAt: "2026-10-23T10:00:00.000Z",
    durationMs: 42000,
    userAgent: "test",
    pages: [{ url: p.target, status: 200, via: "start" }],
    scenarios: [run("none", "not_applicable", { cmp: "Cookiebot" }), run("accept", "clicked", { cmp: "Cookiebot" }), run("reject", "clicked", { cmp: "Cookiebot" })],
    conversionPoints: [],
    platformHints: [],
    ...p,
  };
}

const cookie = (scenario: Scenario, name: string, phase: ConsentPhase = "post"): CookieRecord => ({ scenario, phase, name, domain: ".clean.example", firstParty: true });

/* (a) Clean site: Consent Mode v2 with denied defaults, GTM-loaded GA4, tracked tel click. */
export function cleanSite(): { capture: Capture; hits: DecodedHit[] } {
  const site = "https://clean.example/";
  const gtag = (s: Scenario) => req({ url: "https://www.googletagmanager.com/gtag/js?id=G-CLEAN1&cx=c&gtm=45je", scenario: s, pageUrl: site, phase: "pre" });
  const tel: ConversionPoint = {
    id: "cp-tel",
    type: "contact_click",
    pageUrl: site,
    label: "Phone link",
    detectedBy: "generic",
    confidence: 0.9,
    walk: [{ name: "click", action: "clicked tel: link", ok: true, pageUrl: site, ts: 5000, scenario: "accept" }],
  };
  return {
    capture: capture({
      target: site,
      scenarios: [
        run("none", "not_applicable", { cmp: "Cookiebot", requests: [gtag("none")] }),
        run("accept", "clicked", { cmp: "Cookiebot", requests: [gtag("accept")], cookies: [cookie("accept", "_ga")] }),
        run("reject", "clicked", { cmp: "Cookiebot", requests: [gtag("reject")] }),
      ],
      conversionPoints: [tel],
    }),
    hits: [
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-CLEAN1", scenario: "none", phase: "pre", pageUrl: site, consent: consent("denied") }),
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-CLEAN1", scenario: "reject", phase: "pre", pageUrl: site, consent: consent("denied") }),
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-CLEAN1", scenario: "reject", phase: "post", ts: 6000, pageUrl: "https://clean.example/about", consent: consent("denied") }),
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-CLEAN1", scenario: "accept", phase: "post", ts: 3000, pageUrl: site, consent: consent("granted") }),
      hit({ vendor: "meta", eventName: "PageView", accountId: "123", scenario: "accept", phase: "post", ts: 3100, pageUrl: site }),
      hit({ vendor: "ga4", eventName: "contact_click", accountId: "G-CLEAN1", scenario: "accept", phase: "post", ts: 5200, pageUrl: site, params: { method: "tel" }, consent: consent("granted") }),
    ],
  };
}

/* (b) Tags fire before consent: CMP present, no Consent Mode, GA4 + Meta in scenario none. */
export function tagsBeforeConsent(): { capture: Capture; hits: DecodedHit[] } {
  const site = "https://early.example/";
  return {
    capture: capture({ target: site }),
    hits: [
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-EARLY1", scenario: "none", phase: "pre", pageUrl: site }),
      hit({ vendor: "meta", eventName: "PageView", accountId: "999", scenario: "none", phase: "pre", pageUrl: site }),
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-EARLY1", scenario: "accept", phase: "post", ts: 3000, pageUrl: site }),
    ],
  };
}

/* (c) Shop: funnel walked, add_to_cart without currency, begin_checkout untracked, Meta without eventID. */
export function shopSite(): { capture: Capture; hits: DecodedHit[] } {
  const p = "https://shop.example/product/mug";
  const cart = "https://shop.example/cart";
  const walk: ConversionPoint = {
    id: "cp-shop",
    type: "purchase",
    pageUrl: p,
    label: "Shopify checkout",
    detectedBy: "shopify",
    confidence: 0.95,
    walk: [
      { name: "view_item", action: "opened product page", ok: true, pageUrl: p, ts: 2000, scenario: "accept" },
      { name: "add_to_cart", action: "clicked add to cart", ok: true, pageUrl: p, ts: 4000, scenario: "accept" },
      { name: "begin_checkout", action: "clicked checkout", ok: true, pageUrl: cart, ts: 7000, scenario: "accept" },
    ],
  };
  const items = [{ item_id: "MUG1", item_name: "Mug", price: 12 }];
  return {
    capture: capture({ target: "https://shop.example/", platformHints: ["Shopify"], conversionPoints: [walk] }),
    hits: [
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-SHOP1", scenario: "none", phase: "pre", pageUrl: "https://shop.example/", consent: consent("denied") }),
      hit({ vendor: "ga4", eventName: "view_item", accountId: "G-SHOP1", ts: 2300, pageUrl: p, params: { currency: "EUR", value: 12, items }, consent: consent("granted") }),
      hit({ vendor: "ga4", eventName: "add_to_cart", accountId: "G-SHOP1", ts: 4200, pageUrl: p, params: { value: 12, items }, consent: consent("granted") }),
      hit({ vendor: "meta", eventName: "AddToCart", accountId: "555", ts: 4250, pageUrl: p, params: { value: 12, currency: "EUR" } }),
    ],
  };
}

/* (d) Lead form site: form found and focused, no form_start, no generate_lead anywhere. */
export function leadSite(): { capture: Capture; hits: DecodedHit[] } {
  const c = "https://lead.example/contact";
  const form: ConversionPoint = {
    id: "cp-form",
    type: "lead",
    pageUrl: c,
    label: "Contact form (3 fields)",
    detectedBy: "cf7",
    confidence: 0.85,
    walk: [{ name: "form_start", action: "focused message field", ok: true, pageUrl: c, ts: 6000, scenario: "accept" }],
  };
  return {
    capture: capture({ target: "https://lead.example/", platformHints: ["WordPress"], conversionPoints: [form] }),
    hits: [
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-LEAD1", scenario: "accept", phase: "post", ts: 3000, pageUrl: "https://lead.example/", consent: consent("granted") }),
      hit({ vendor: "ga4", eventName: "page_view", accountId: "G-LEAD1", scenario: "accept", phase: "post", ts: 5000, pageUrl: c, consent: consent("granted") }),
    ],
  };
}
