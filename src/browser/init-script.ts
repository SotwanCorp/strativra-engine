/**
 * Init script injected into every frame before any page script runs.
 *
 * - Wraps `window.dataLayer.push`, including a dataLayer assigned later
 *   (accessor on window) and a push replaced later by GTM (accessor on the
 *   array). Re-entrant calls (GTM's push calling the previous push) are not
 *   recorded twice.
 * - Keeps timestamped, JSON-safe, PII-redacted copies in a closure (not on
 *   window). Emails become "[email]"; digit runs of 9+ digits (phone-like)
 *   become "[digits:<hash>]" with a short non-reversible hash so equality
 *   (e.g. transaction_id reuse) can still be compared.
 * - `window.__strvRead()` drains the copies and reads the live gtag consent
 *   state (`google_tag_data.ics.entries`) and `google_tag_manager` keys.
 *
 * Not stealth: it does not hide itself or alter fingerprints.
 */

import type { Page, Frame } from "playwright-core";
import type { ConsentKey, ConsentValue } from "../types.ts";

export const INIT_SCRIPT = String.raw`(() => {
  if (Object.prototype.hasOwnProperty.call(window, "__strvRead")) return;
  var MAX_ENTRIES = 1000, MAX_DEPTH = 6, MAX_KEYS = 100, MAX_ITEMS = 50, MAX_STR = 2000;
  var store = [];
  var dropped = 0;
  var EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
  var DIGITS = /\+?\d[\d\s().\-\/]{7,}\d/g;
  function h(s) {
    var x = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return (x >>> 16).toString(16);
  }
  function redact(s) {
    s = s.replace(EMAIL, "[email]");
    s = s.replace(DIGITS, function (m) {
      var d = m.replace(/\D/g, "");
      return d.length >= 9 ? "[digits:" + h(d) + "]" : m;
    });
    return s.length > MAX_STR ? s.slice(0, MAX_STR) + "...[truncated]" : s;
  }
  function safe(v, depth, seen) {
    if (v === null || v === undefined) return v === null ? null : "[undefined]";
    var t = typeof v;
    if (t === "string") return redact(v);
    if (t === "number") return isFinite(v) ? v : String(v);
    if (t === "boolean") return v;
    if (t === "bigint") return String(v);
    if (t === "function") return "[function]";
    if (t === "symbol") return "[symbol]";
    if (depth >= MAX_DEPTH) return "[depth]";
    try {
      if (typeof Node !== "undefined" && v instanceof Node) return "[element " + (v.nodeName || "").toLowerCase() + "]";
      if (typeof Window !== "undefined" && v instanceof Window) return "[window]";
    } catch (e) {}
    if (seen.indexOf(v) >= 0) return "[circular]";
    seen.push(v);
    var tag = Object.prototype.toString.call(v);
    var out;
    if (tag === "[object Arguments]") {
      out = { __gtag: safe(Array.prototype.slice.call(v), depth + 1, seen) };
    } else if (Array.isArray(v)) {
      out = [];
      for (var i = 0; i < v.length && i < MAX_ITEMS; i++) out.push(safe(v[i], depth + 1, seen));
    } else if (tag === "[object Date]") {
      out = isNaN(v) ? "[date]" : v.toISOString();
    } else {
      out = {};
      var keys = [];
      try { keys = Object.keys(v); } catch (e) {}
      for (var k = 0; k < keys.length && k < MAX_KEYS; k++) {
        var val;
        try { val = v[keys[k]]; } catch (e) { val = "[unreadable]"; }
        out[redact(keys[k])] = safe(val, depth + 1, seen);
      }
    }
    seen.pop();
    return out;
  }
  function record(item) {
    if (store.length >= MAX_ENTRIES) { dropped++; return; }
    var p;
    try { p = safe(item, 0, []); } catch (e) { p = "[unserializable]"; }
    store.push({ t: Date.now(), p: p });
  }
  var marked = typeof WeakSet === "function" ? new WeakSet() : null;
  function instrument(arr) {
    if (!Array.isArray(arr) || !marked || marked.has(arr)) return;
    marked.add(arr);
    for (var i = 0; i < arr.length; i++) record(arr[i]);
    var inner = arr.push;
    var depth = 0;
    function wrapped() {
      if (depth > 0) return Array.prototype.push.apply(this, arguments);
      for (var j = 0; j < arguments.length; j++) record(arguments[j]);
      depth++;
      try { return inner.apply(this, arguments); } finally { depth--; }
    }
    try {
      Object.defineProperty(arr, "push", {
        configurable: true, enumerable: false,
        get: function () { return wrapped; },
        set: function (fn) { if (typeof fn === "function" && fn !== wrapped) inner = fn; },
      });
    } catch (e) {}
  }
  var current = window.dataLayer;
  if (current) instrument(current);
  try {
    Object.defineProperty(window, "dataLayer", {
      configurable: true, enumerable: true,
      get: function () { return current; },
      set: function (v) { current = v; instrument(v); },
    });
  } catch (e) {
    var poll = setInterval(function () { if (window.dataLayer) { instrument(window.dataLayer); } }, 250);
    setTimeout(function () { clearInterval(poll); }, 30000);
  }
  function readIcs() {
    try {
      var e = window.google_tag_data && window.google_tag_data.ics && window.google_tag_data.ics.entries;
      if (!e) return null;
      var out = {};
      Object.keys(e).forEach(function (k) {
        var x = e[k] || {};
        out[k] = { default: typeof x.default === "boolean" ? x.default : null, update: typeof x.update === "boolean" ? x.update : null };
      });
      return out;
    } catch (err) { return null; }
  }
  Object.defineProperty(window, "__strvRead", {
    configurable: false, enumerable: false, writable: false,
    value: function () {
      var dl = store.splice(0, store.length);
      var d = dropped; dropped = 0;
      var gtm = [];
      try { gtm = Object.keys(window.google_tag_manager || {}); } catch (e) {}
      return { dataLayer: dl, dropped: d, ics: readIcs(), gtmKeys: gtm };
    },
  });
})();`;

export interface IcsEntry {
  default: boolean | null;
  update: boolean | null;
}

export interface PageState {
  dataLayer: Array<{ t: number; p: unknown }>;
  dropped: number;
  ics: Record<string, IcsEntry> | null;
  gtmKeys: string[];
}

/** Drain recorded pushes + read consent state. Never throws (returns null on failure). */
export async function readPageState(target: Page | Frame): Promise<PageState | null> {
  try {
    const r = await target.evaluate(() => {
      const w = window as unknown as { __strvRead?: () => unknown };
      return typeof w.__strvRead === "function" ? w.__strvRead() : null;
    });
    return (r as PageState | null) ?? null;
  } catch {
    return null;
  }
}

const CONSENT_KEYS: ConsentKey[] = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"];

/** Map google_tag_data.ics entries to our consent values (update wins over default). */
export function icsToConsent(ics: Record<string, IcsEntry> | null): Partial<Record<ConsentKey, ConsentValue>> | undefined {
  if (!ics) return undefined;
  const out: Partial<Record<ConsentKey, ConsentValue>> = {};
  for (const k of CONSENT_KEYS) {
    const e = ics[k];
    if (!e) {
      out[k] = "unset";
      continue;
    }
    const v = e.update ?? e.default;
    out[k] = v === true ? "granted" : v === false ? "denied" : "unset";
  }
  return out;
}
