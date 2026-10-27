/**
 * Every visible string of the extension (DRAFT, awaiting owner approval; mirrored in
 * strativra/site-copy/15-connectors.md). Copy rules: no em or en dashes, no prices, CTA labels only
 * from the CLAUDE.md table ("Book a Tracking Audit" for the audit).
 */
import type { Choice, Visitor } from "./record.ts";
import type { Scenario } from "../../types.ts";

export const S = {
  brand: "Strativra",
  settings: "Settings",
  back: "Back",

  keyLabel: "API key",
  keyHelp: "Create a key in your Strativra account. It stays in this browser.",
  keyLink: "Open my account",
  baseLabel: "Server",
  baseHelp: "Leave as is unless you run a local copy.",
  save: "Save",
  saved: "Saved.",
  keyErrors: {
    empty: "Paste your API key first.",
    format: "That is not a Strativra API key. It starts with strv_live_.",
    checksum: "That key looks cut off or mistyped. Copy it again.",
  },
  baseError: "Use https://strativra.com or a local address (127.0.0.1 or localhost).",
  needKey: "Add your API key in Settings first.",

  homeTitle: "Check this site's tracking",
  modeA: "Scan on Strativra",
  modeAHelp: "We load the site from our servers, like a new visitor.",
  urlLabel: "Website address",
  urlPlaceholder: "yourwebsite.com",
  modeB: "Record in my browser",
  modeBHelp: "For sites behind a login, on staging or behind bot protection.",

  queued: "Queued",
  running: "Scanning",
  position: (n: number) => `Position ${n} in the queue`,
  reportReady: "Report ready",
  openReport: "Open report",
  audit: "Book a Tracking Audit",
  scanFailed: "The scan did not finish.",
  botWall: "This site blocked our scanner. Record it in your browser instead.",

  visitorTitle: "Visitor",
  fresh: "Fresh visitor",
  freshHelp: "Clears this site's cookies and storage, then reloads.",
  returning: "As is (returning visitor)",
  returningHelp: "Keeps your login and saved choices.",
  pathTitle: "Path",
  pathNone: "Just browse",
  pathLead: "Lead form",
  pathShop: "Shop checkout",
  start: "Start recording",
  confirmTitle: (host: string) => `Clear ${host}?`,
  confirmBody: "Its cookies and storage in this browser are deleted. You will be signed out of it.",
  confirmYes: "Clear and record",
  cancel: "Cancel",
  permDenied: "Recording needs access to the sites this tab loads. Nothing was recorded.",
  badTab: "Open the site you want to check in this tab first.",

  rec: "Recording",
  countRequests: "Requests",
  countTracking: "Tracking hits",
  countDataLayer: "dataLayer pushes",
  consentTitle: "Consent",
  clickedAccept: "I clicked Accept",
  clickedReject: "I clicked Reject",
  consentNone: "No consent choice yet.",
  consentSeen: (c: Choice, source: "button" | "auto") => `${c === "accept" ? "Accept" : "Reject"}, ${source === "auto" ? "seen in the page" : "marked by you"}`,
  stepsTitle: "Steps",
  stepDone: "Done",
  stepSkip: "Skip",
  stepsFinished: "All steps done.",
  stop: "Stop recording",
  tabClosed: "The recorded tab was closed. Stop to review what was recorded.",

  reviewTitle: "Review",
  reviewHelp: "Nothing has left your browser. Remove any host you don't want to send.",
  countCookies: "Cookies",
  countPages: "Pages",
  hostsTitle: "Hosts",
  remove: "Remove",
  thisSite: "this site",
  scenarioLabel: { none: "No consent choice", accept: "Accepted", reject: "Rejected" } satisfies Record<Scenario, string>,
  visitorLabel: { fresh: "Fresh visitor", returning: "Returning visitor" } satisfies Record<Visitor, string>,
  upload: "Upload",
  discard: "Discard",
  uploading: "Uploading",
  building: "Building your report",

  errors: {
    unauthorized: "That key was not accepted. Check it in Settings.",
    forbidden: "This key can't do that. Create one with scan and capture access.",
    quota_exceeded: "You have used this month's scans.",
    rate_limited: "Too many requests. Try again in a minute.",
    invalid_url: "That doesn't look like a web address. Try something like yourwebsite.com",
    invalid_capture: "The recording could not be read. Record it again.",
    payload_too_large: "This recording is too large to upload. Record a shorter visit.",
    engine_unavailable: "The scanner is busy. Try again in a few minutes.",
    not_verified: "Verify this site in your account to get the full report.",
    consent_required: "Accept the terms in your account first.",
    network: "Strativra could not be reached. Check your connection.",
    timeout: "The scan is taking longer than usual. Check your account later.",
    generic: "Something went wrong. Try again.",
  } as Record<string, string>,
};

export function errorText(code: string | undefined): string {
  return (code && S.errors[code]) || S.errors.generic;
}

/** Every string literal above, for the copy-rule test. */
export function allStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "function") out.push(String((v as (...a: never[]) => string)("x" as never, "auto" as never)));
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(S);
  return out;
}
