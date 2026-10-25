/**
 * Raw recording records (what the service worker persists to IndexedDB in batches) and the small
 * pure helpers the recorder uses. Times are epoch ms; build.ts turns them into ms since the start.
 */
import { isTrackingUrl, registrableDomain } from "../../browser/capture.ts";
import type { IcsEntry } from "../../browser/init-script.ts";
import type { ConversionType } from "../../types.ts";

export type Visitor = "fresh" | "returning";
export type Choice = "accept" | "reject";

export interface RawRequest {
  /** chrome.webRequest requestId (shared by the hops of a redirect). */
  rid: string;
  url: string;
  method: string;
  /** chrome.webRequest resource type (main_frame, xmlhttprequest, ping, ...). */
  type: string;
  ts: number;
  /** Top-level page URL when the request was made. */
  pageUrl: string;
  frameId: number;
  body?: string;
}

export interface RawError {
  rid: string;
  error: string;
  ts: number;
}

export interface RawPush {
  t: number;
  p: unknown;
  pageUrl: string;
}

export interface RawIcs {
  t: number;
  ics: Record<string, IcsEntry> | null;
}

export interface RawNav {
  ts: number;
  url: string;
  kind: "commit" | "spa";
  status?: number;
}

export interface RawCookies {
  ts: number;
  list: Array<{ name: string; domain: string }>;
}

export interface Marker {
  /** When the consent choice happened (the page click it belongs to, or the consent push). */
  ts: number;
  choice: Choice;
  source: "button" | "auto";
}

/** Template step as bundled (templates/*.json). */
export interface TemplateStep {
  id: string;
  /** snake_case funnel step name the engine understands (view_item, add_to_cart, form_start, ...). */
  name: string;
  label: string;
  /** Past tense, for the report: "Opened a product page". */
  action: string;
  /** Which moment counts as the step: the last page load, the last click, either, or the button press. */
  at: "page_load" | "click" | "any" | "now";
  conversionType?: ConversionType;
  /** The last step: stop before submit or pay. Recorded as stopped. */
  final?: boolean;
}

export interface Template {
  id: "lead" | "ecommerce";
  name: string;
  conversionType: ConversionType;
  steps: TemplateStep[];
}

export interface StepRecord {
  id: string;
  name: string;
  action: string;
  at: TemplateStep["at"];
  conversionType?: ConversionType;
  status: "done" | "skipped" | "stopped";
  /** When the person pressed Done / Skip in the panel. */
  doneTs: number;
}

/** Chrome resource types mapped to the names the engine (Playwright) uses. */
const RESOURCE_TYPES: Record<string, string> = {
  main_frame: "document",
  sub_frame: "sub_frame",
  xmlhttprequest: "xhr",
  ping: "ping",
  script: "script",
  image: "image",
  imageset: "image",
  stylesheet: "stylesheet",
  font: "font",
  media: "media",
  websocket: "websocket",
  csp_report: "csp_report",
  object: "other",
  other: "other",
};

export function mapResourceType(t: string): string {
  return RESOURCE_TYPES[t] ?? "other";
}

/** Bodies only for tracking destinations and first-party collect paths (the engine allow-list). */
export function shouldKeepBody(url: string, method: string): boolean {
  return method.toUpperCase() !== "GET" && isTrackingUrl(url);
}

/** http(s) page URLs only (no chrome://, file:, Web Store pages). */
export function recordableUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname === "chromewebstore.google.com" || (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore"))) return null;
    return u;
  } catch {
    return null;
  }
}

/** Host permissions requested on Start (CONNECTORS.md 8), removed after upload. */
export const RECORDING_ORIGINS = ["https://*/*", "http://*/*"];

/**
 * Match patterns for the content scripts: the site's registrable domain and its subdomains, on the
 * site's own scheme. IP hosts and single-label hosts match exactly.
 */
export function siteMatchPatterns(siteUrl: string): string[] {
  const u = new URL(siteUrl);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const scheme = u.protocol.replace(":", "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return [`${scheme}://${u.hostname}/*`];
  const base = registrableDomain(host);
  return [`${scheme}://${base}/*`, `${scheme}://*.${base}/*`];
}

/** Optional host permissions to drop after an upload: everything granted except the API base URL's own pattern. */
export function originsToRemove(granted: string[], keep: string[]): string[] {
  const k = new Set(keep);
  return granted.filter((o) => !k.has(o) && o !== "https://strativra.com/*");
}

/** The pattern that covers the API base URL (kept when the recording permissions are removed). */
export function basePattern(base: string): string {
  const u = new URL(base);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Same first-party test the engine uses for cookies: same registrable domain. */
export function isFirstPartyDomain(domain: string, siteHost: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  return registrableDomain(d) === registrableDomain(siteHost);
}
