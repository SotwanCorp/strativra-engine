/**
 * Shared contract for the whole engine. Every module codes against these
 * types: capture (browser runner) -> decode -> detect -> rules -> report.
 * Change a type here first, then the modules. Erasable syntax only
 * (no enums, no parameter properties) so Node can strip types directly.
 */

/* ------------------------------------------------------------------ */
/* Scenarios and capture                                               */
/* ------------------------------------------------------------------ */

/** One fresh browser context per scenario. */
export type Scenario = "none" | "accept" | "reject";

/** Whether a request happened before or after the consent click in its scenario. */
export type ConsentPhase = "pre" | "post";

export interface CapturedRequest {
  id: string;
  scenario: Scenario;
  phase: ConsentPhase;
  /** ms since the scenario started. */
  ts: number;
  /** Top-level page URL when the request was made. */
  pageUrl: string;
  url: string;
  method: string;
  /** Raw body, capped (64 KB). Never stored for non-tracking hosts. */
  postData?: string;
  resourceType: string;
  /** True when we aborted it (safety block: form POST, payment endpoint, SSRF). */
  blocked?: BlockReason;
  /** Network error text when the request failed for any other reason (DNS, refused, blocked egress, ad blocker). */
  failed?: string;
}

export type BlockReason = "ssrf" | "form_submit" | "payment" | "unsafe_method" | "limit";

export interface DataLayerPush {
  scenario: Scenario;
  phase: ConsentPhase;
  ts: number;
  pageUrl: string;
  /** JSON-safe copy of the pushed object, PII-redacted (emails, phones). */
  payload: unknown;
}

export interface CookieRecord {
  scenario: Scenario;
  phase: ConsentPhase;
  name: string;
  domain: string;
  /** Values are never kept. */
  firstParty: boolean;
}

export type BannerOutcome =
  | "clicked"            // accept/reject clicked and the banner went away
  | "no_banner"          // nothing found
  | "not_clickable"      // banner found, the wanted button was not
  | "not_applicable"     // scenario "none"
  | "blocked_by_bot_protection";

export interface ScenarioRun {
  scenario: Scenario;
  banner: BannerOutcome;
  /** CMP name if identified (autoconsent rule name or our fallback). */
  cmp?: string;
  bannerMethod?: "autoconsent" | "fallback";
  requests: CapturedRequest[];
  dataLayer: DataLayerPush[];
  cookies: CookieRecord[];
  /** Live gtag consent state read from google_tag_data.ics, per phase. */
  gtagConsent?: Partial<Record<ConsentPhase, Partial<Record<ConsentKey, ConsentValue>>>>;
  /** Screenshot keys (storage-relative paths). */
  screenshots: Screenshot[];
  errors: string[];
}

export interface Screenshot {
  key: string;
  caption: string;
  pageUrl: string;
  scenario: Scenario;
}

export interface PageVisit {
  url: string;
  status: number | null;
  /** How we got there. */
  via: "start" | "link" | "spa_route" | "funnel";
  title?: string;
}

/** Raw output of one run of the browser runner. Input to everything else. */
export interface Capture {
  target: string;
  finalUrl: string;
  /** Egress region label, printed in the report (e.g. "EU (Germany)"). */
  region: string;
  startedAt: string;
  durationMs: number;
  userAgent: string;
  pages: PageVisit[];
  scenarios: ScenarioRun[];
  conversionPoints: ConversionPoint[];
  /** Platform/CMS hints (Shopify, WordPress, Webflow, Lovable, ...). */
  platformHints: string[];
  /** Set when the whole run could not proceed. */
  aborted?: { reason: "bot_protection" | "timeout" | "unreachable" | "not_html"; detail: string };
}

/* ------------------------------------------------------------------ */
/* Decoded hits                                                         */
/* ------------------------------------------------------------------ */

export type Vendor =
  | "ga4"
  | "google_ads"
  | "floodlight"
  | "meta"
  | "linkedin"
  | "tiktok"
  | "ms_uet"
  | "gtm"          // container load
  | "sgtm"         // likely server-side GTM endpoint (first-party)
  | "other";

export type ConsentKey = "ad_storage" | "analytics_storage" | "ad_user_data" | "ad_personalization";
export type ConsentValue = "granted" | "denied" | "unset" | "unknown";

export interface ConsentSignals {
  raw: { gcs?: string; gcd?: string; dma?: string; npa?: string };
  /** From gcd when present (default + update), else from gcs (current only). */
  keys: Partial<Record<ConsentKey, { default: ConsentValue; update: ConsentValue; current: ConsentValue }>>;
  /** Letters we could not map (gcd map is not published by Google). */
  unknownLetters: string[];
}

export interface DecodedHit {
  requestId: string;
  scenario: Scenario;
  phase: ConsentPhase;
  ts: number;
  pageUrl: string;
  vendor: Vendor;
  /** Account / property / pixel id: G-XXXX, AW-123, pixel id, partner id... */
  accountId?: string;
  /** Normalised event name: page_view, purchase, Lead, conversion... */
  eventName: string;
  /** Google Ads conversion label, when relevant. */
  conversionLabel?: string;
  /** Flattened params (ep.* -> string, epn.* -> number, items kept as array). */
  params: Record<string, string | number | unknown[]>;
  /** Meta eventID / eid, used for CAPI dedup readiness. */
  eventId?: string;
  consent?: ConsentSignals;
  /** Hit sent to the site's own domain (sGTM or proxy). */
  firstParty: boolean;
  /** Set when our capture layer aborted the request, so it never reached the vendor. */
  blocked?: BlockReason;
}

/* ------------------------------------------------------------------ */
/* Conversions                                                          */
/* ------------------------------------------------------------------ */

export type ConversionType = "purchase" | "lead" | "booking" | "signup" | "contact_click" | "download";

export interface ConversionPoint {
  id: string;
  type: ConversionType;
  pageUrl: string;
  /** Short human hint: "Contact form (3 fields)", "Calendly inline embed". */
  label: string;
  /** CSS selector usable to re-find it (best effort). */
  selector?: string;
  /** Adapter id that recognised it, or "generic". */
  detectedBy: string;
  confidence: number; // 0..1
  /** Funnel steps we walked, in order, and how far we got (never the final step). */
  walk: FunnelStep[];
}

export interface FunnelStep {
  name: string;          // "view_item", "add_to_cart", "begin_checkout", "form_start", "click"...
  action: string;        // what we did: "clicked add to cart", "focused message field"
  ok: boolean;
  pageUrl: string;
  ts: number;
  scenario: Scenario;
}

/** Expected tracking for one conversion type. Data, not code. */
export interface EventContract {
  type: ConversionType;
  /** Steps before the conversion we expect to see tracked (walkable). */
  funnel: Array<{ step: string; ga4: string[]; required: boolean }>;
  ga4: { events: string[]; requiredParams: string[]; recommendedParams: string[] };
  googleAds?: { expectConversion: boolean; enhancedConversions: boolean };
  meta?: { events: string[]; requiredParams: string[]; needsEventId: boolean };
  /** Notes for the report appendix. */
  notes: string[];
  /** Source URLs. Must be re-verified against live docs before launch. */
  sources: string[];
}

export type ContractStatus = "ok" | "partial" | "broken" | "not_tracked" | "not_testable";

export interface ConversionStatus {
  type: ConversionType;
  points: string[]; // ConversionPoint ids
  status: ContractStatus;
  /** One line, plain English. */
  summary: string;
}

/* ------------------------------------------------------------------ */
/* Findings and report                                                  */
/* ------------------------------------------------------------------ */

export type Severity = "critical" | "high" | "medium" | "low";

export interface Evidence {
  kind: "hit" | "datalayer" | "cookie" | "screenshot" | "html" | "note";
  caption: string;
  /** DecodedHit.requestId, Screenshot.key, etc. */
  ref?: string;
  /** Small JSON-safe excerpt to display. */
  data?: unknown;
}

export interface Finding {
  /** Rule id, stable across runs: "consent.fires_before_consent". */
  id: string;
  title: string;
  severity: Severity;
  /** Plain-English "why it matters", one or two short sentences. */
  why: string;
  conversionTypes: ConversionType[];
  vendors: Vendor[];
  impact: 1 | 2 | 3 | 4 | 5;
  confidence: 1 | 2 | 3;
  reach: 1 | 2 | 3;
  effort: 1 | 2 | 3;
  /** Reproduced and evidenced in this run. Unreproduced findings never enter the open top 3. */
  reproduced: boolean;
  evidence: Evidence[];
  fix: { summary: string; steps: string[] };
}

export type ReportKind = "free" | "paid";

export interface StackItem {
  vendor: Vendor | "cmp" | "platform";
  name: string;
  ids: string[];
  source: "network" | "html" | "global";
  firstParty?: boolean;
}

export interface Report {
  id: string;
  kind: ReportKind;
  target: string;
  finalUrl: string;
  generatedAt: string;
  region: string;
  stack: StackItem[];
  conversions: ConversionStatus[];
  /** Sorted by rank (see rules/rank.ts). */
  findings: Finding[];
  /** Ids of the open findings (top 3 on free, all on paid). */
  open: string[];
  counts: Record<Severity, number>;
  /** One line per top finding: why it is ranked there. */
  rankNotes: Record<string, string>;
  scan: { pages: number; durationMs: number; banner: Partial<Record<Scenario, BannerOutcome>>; aborted?: Capture["aborted"] };
}
