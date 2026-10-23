/**
 * Event contracts: what correct tracking looks like per conversion type.
 * Data, not code. Rules in src/core/rules/ read these.
 *
 * Verification status (2026-10-23): developers.google.com,
 * support.google.com and developers.facebook.com did not resolve from the
 * build sandbox, so NONE of these were re-verified live. They follow the
 * 2026-10-23 benchmark. Re-verify every `sources` URL before launch.
 *
 * Funnel `ga4: ["*"]` means "any non-automatic GA4 event" (a custom click
 * event name is fine, as long as something fires).
 */
import type { ConversionType, EventContract } from "../types.ts";

const UNVERIFIED = "Not re-verified live on 2026-10-23 (docs host unreachable from the build sandbox). Re-verify before launch.";

/** GA4 events that fire on their own and never count as a tracked step. */
export const GA4_AUTOMATIC_EVENTS: readonly string[] = [
  "page_view",
  "user_engagement",
  "scroll",
  "session_start",
  "first_visit",
  "view_search_results",
  "video_start",
  "video_progress",
  "video_complete",
];

/** GA4 ecommerce events that need currency + value + items. */
export const GA4_ECOMMERCE_EVENTS: readonly string[] = [
  "view_item",
  "view_item_list",
  "select_item",
  "add_to_cart",
  "remove_from_cart",
  "view_cart",
  "begin_checkout",
  "add_shipping_info",
  "add_payment_info",
  "purchase",
  "refund",
];

/** Final conversion events per vendor. We never submit or pay, so any of these firing during a scan is a false conversion. */
export const FINAL_GA4_EVENTS: readonly string[] = ["purchase", "generate_lead", "sign_up", "close_convert_lead", "qualify_lead"];
export const FINAL_META_EVENTS: readonly string[] = ["Purchase", "Lead", "CompleteRegistration", "Schedule", "Subscribe", "StartTrial", "SubmitApplication"];

export const CONTRACTS: Record<ConversionType, EventContract> = {
  purchase: {
    type: "purchase",
    funnel: [
      { step: "view_item", ga4: ["view_item"], required: true },
      { step: "add_to_cart", ga4: ["add_to_cart"], required: true },
      { step: "begin_checkout", ga4: ["begin_checkout"], required: true },
    ],
    ga4: {
      events: ["purchase"],
      requiredParams: ["transaction_id", "currency", "value", "items"],
      recommendedParams: ["tax", "shipping", "coupon"],
    },
    googleAds: { expectConversion: true, enhancedConversions: false },
    meta: { events: ["Purchase"], requiredParams: ["value", "currency"], needsEventId: true },
    notes: [
      "Purchase pass bar: transaction_id, currency, value (a number) and items. Each item needs item_id or item_name.",
      "add_payment_info and purchase are never walked: we never pay.",
      "Google Ads conversion should carry the value and the transaction id (oid) so duplicates are dropped.",
      "Meta Purchase needs value, currency and an eventID so browser and server events can be deduplicated.",
      "transaction_id should stay unique across a reload of the thank-you page.",
      UNVERIFIED,
    ],
    sources: [
      "https://developers.google.com/analytics/devguides/collection/ga4/reference/events#purchase",
      "https://developers.google.com/analytics/devguides/collection/ga4/ecommerce",
      "https://support.google.com/google-ads/answer/6386790",
      "https://developers.facebook.com/docs/meta-pixel/reference",
      "https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events",
    ],
  },
  lead: {
    type: "lead",
    funnel: [{ step: "form_start", ga4: ["form_start"], required: false }],
    ga4: { events: ["generate_lead"], requiredParams: ["value", "currency"], recommendedParams: ["lead_source"] },
    googleAds: { expectConversion: true, enhancedConversions: true },
    meta: { events: ["Lead"], requiredParams: [], needsEventId: true },
    notes: [
      "generate_lead with value and currency, fired on a real success (thank-you page or success callback), not on the button click.",
      "form_start and form_submit from enhanced measurement are not enough on their own: form_submit fires on submit attempts, including failed ones.",
      "Google Ads conversion for leads, with enhanced conversions for leads where used.",
      "Meta Lead with an eventID for deduplication.",
      UNVERIFIED,
    ],
    sources: [
      "https://developers.google.com/analytics/devguides/collection/ga4/reference/events#generate_lead",
      "https://support.google.com/analytics/answer/9216061",
      "https://support.google.com/google-ads/answer/11021502",
      "https://developers.facebook.com/docs/meta-pixel/reference",
    ],
  },
  booking: {
    type: "booking",
    funnel: [],
    ga4: { events: ["generate_lead", "book_appointment", "booking_confirmed"], requiredParams: [], recommendedParams: ["value", "currency"] },
    googleAds: { expectConversion: true, enhancedConversions: false },
    meta: { events: ["Schedule"], requiredParams: [], needsEventId: true },
    notes: [
      "The conversion fires exactly once, on a confirmed booking, attributed to the original session.",
      "Schedulers usually run in an iframe on another domain, so the site needs a postMessage listener that pushes the event into its own dataLayer.",
      "GA4: generate_lead or a custom booking event. Meta: Schedule.",
      UNVERIFIED,
    ],
    sources: [
      "https://help.calendly.com/hc/en-us/articles/223147027",
      "https://developers.facebook.com/docs/meta-pixel/reference",
    ],
  },
  signup: {
    type: "signup",
    funnel: [],
    ga4: { events: ["sign_up"], requiredParams: ["method"], recommendedParams: [] },
    googleAds: { expectConversion: true, enhancedConversions: false },
    meta: { events: ["CompleteRegistration"], requiredParams: [], needsEventId: true },
    notes: ["sign_up with method, fired once and only after success.", "Meta CompleteRegistration.", UNVERIFIED],
    sources: [
      "https://developers.google.com/analytics/devguides/collection/ga4/reference/events#sign_up",
      "https://developers.facebook.com/docs/meta-pixel/reference",
    ],
  },
  contact_click: {
    type: "contact_click",
    funnel: [{ step: "click", ga4: ["*"], required: true }],
    ga4: { events: ["*"], requiredParams: [], recommendedParams: ["link_url", "method"] },
    googleAds: { expectConversion: false, enhancedConversions: false },
    meta: { events: ["Contact"], requiredParams: [], needsEventId: false },
    notes: [
      "One click event per channel (tel, mailto, WhatsApp, chat open). The name is free, but each channel must be told apart.",
      "Meta Contact and a Google Ads conversion are optional.",
      UNVERIFIED,
    ],
    sources: ["https://developers.facebook.com/docs/meta-pixel/reference"],
  },
  download: {
    type: "download",
    funnel: [{ step: "click", ga4: ["file_download"], required: true }],
    ga4: { events: ["file_download"], requiredParams: [], recommendedParams: ["file_name", "file_extension", "link_url"] },
    notes: ["file_download (enhanced measurement or a custom tag).", UNVERIFIED],
    sources: ["https://support.google.com/analytics/answer/9216061"],
  },
};
