/**
 * GA4 Measurement Protocol (web, v=2) decoder: /g/collect.
 *
 * Batching (gtag.js): shared params sit in the query string. When several
 * events are sent at once, the POST body holds one URL-encoded param string
 * per line, each merged over the shared query params. If the query string
 * already carries an `en`, it is decoded as an event too (single-event hits
 * and the "first event in the query" shape). Body lines without an `en` are
 * skipped. Every event of a batch keeps the same requestId.
 *
 * Never kept: cid / uid values (presence only), user properties (up.*, upn.*).
 */
import type { CapturedRequest, DecodedHit } from "../../types.ts";
import { decodeConsent } from "./consent.ts";
import {
  baseHit, cappedBody, mergeQs, parseQs, redact, setNum, setStr, toNumber, type Params,
} from "./util.ts";

/** GA4 item keys (pr1..prN) -> item field names. */
const ITEM_KEYS: Record<string, string> = {
  id: "item_id", nm: "item_name", af: "affiliation", cp: "coupon", ds: "discount",
  lp: "index", br: "item_brand", ca: "item_category", c2: "item_category2",
  c3: "item_category3", c4: "item_category4", c5: "item_category5",
  li: "item_list_id", ln: "item_list_name", va: "item_variant", lo: "location_id",
  pr: "price", qt: "quantity", cs: "creative_slot", cn: "creative_name",
  pi: "promotion_id", pn: "promotion_name",
};
const ITEM_NUMERIC = new Set(["price", "quantity", "discount", "index"]);

/** Decodes "idSKU1~nmShirt~pr19.99~qt2~k0color~v0blue" into an item object. */
export function decodeItem(s: string): Record<string, string | number> {
  const item: Record<string, string | number> = {};
  const custom: Record<string, string> = {};
  const customVals: Record<string, string> = {};
  for (const part of s.split("~")) {
    if (part.length < 2) continue;
    const k = part.slice(0, 2);
    const v = part.slice(2);
    const ck = /^k(\d+)$/.exec(k);
    const cv = /^v(\d+)$/.exec(k);
    if (ck) { custom[ck[1]] = v; continue; }
    if (cv) { customVals[cv[1]] = v; continue; }
    const name = ITEM_KEYS[k];
    if (!name) { item[k] = redact(v); continue; }
    if (ITEM_NUMERIC.has(name)) {
      const n = toNumber(v);
      item[name] = n !== undefined ? n : v;
    } else {
      item[name] = redact(v);
    }
  }
  for (const idx of Object.keys(custom)) {
    const name = custom[idx];
    if (name && customVals[idx] !== undefined) item[name] = redact(customVals[idx]);
  }
  return item;
}

const STR_MAP: Record<string, string> = {
  dl: "page_location", dt: "page_title", dr: "page_referrer", ul: "language",
  sr: "screen_resolution", _p: "page_load_id", sid: "session_id", tag_exp: "tag_exp",
  gtm: "gtm",
};
const NUM_MAP: Record<string, string> = {
  _et: "engagement_time_msec", _s: "hit_sequence", sct: "session_count",
};
const FLAG_MAP: Record<string, string> = {
  _ss: "session_start", _fv: "first_visit", _nsi: "new_session_id", seg: "session_engaged",
  _dbg: "debug_mode", ep_debug_mode: "debug_mode",
};

function eventParams(q: URLSearchParams): Params {
  const p: Params = {};
  const items: Array<{ n: number; item: Record<string, string | number> }> = [];
  for (const [k, v] of q) {
    if (k.startsWith("ep.")) {
      setStr(p, k.slice(3), v);
    } else if (k.startsWith("epn.")) {
      const n = toNumber(v);
      if (n !== undefined) p[k.slice(4)] = n;
    } else if (/^pr\d+$/.test(k)) {
      items.push({ n: Number(k.slice(2)), item: decodeItem(v) });
    } else if (STR_MAP[k]) {
      setStr(p, STR_MAP[k], v);
    } else if (NUM_MAP[k]) {
      setNum(p, NUM_MAP[k], v);
    } else if (FLAG_MAP[k]) {
      p[FLAG_MAP[k]] = v === "" ? 1 : (toNumber(v) ?? v);
    }
  }
  if (q.has("cid")) p.client_id = "present";
  if (q.has("uid")) p.user_id = "present";
  // currency: `cu` (gtag) wins, else ep.currency (already copied).
  const cu = q.get("cu");
  if (cu) p.currency = cu;
  if (items.length) {
    items.sort((a, b) => a.n - b.n);
    p.items = items.map((i) => i.item);
  }
  return p;
}

function oneEvent(
  req: CapturedRequest,
  q: URLSearchParams,
  firstParty: boolean,
): DecodedHit {
  const en = q.get("en") || "unknown";
  const hit = baseHit(req, "ga4", en, firstParty);
  const tid = q.get("tid");
  if (tid) hit.accountId = tid;
  hit.params = eventParams(q);
  const consent = decodeConsent(q);
  if (consent) hit.consent = consent;
  return hit;
}

export function decodeGa4(req: CapturedRequest, url: URL, firstParty: boolean): DecodedHit[] {
  const shared = url.searchParams;
  const out: DecodedHit[] = [];
  if (shared.get("en")) out.push(oneEvent(req, shared, firstParty));
  const body = cappedBody(req);
  if (body) {
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const lineQs = parseQs(t);
      if (!lineQs.get("en")) continue;
      out.push(oneEvent(req, mergeQs(shared, lineQs), firstParty));
    }
  }
  return out;
}

/** GA4 request shape: v=2 and a G- measurement id. */
export function looksLikeGa4(q: URLSearchParams): boolean {
  return q.get("v") === "2" && /^G-[A-Z0-9]+$/i.test(q.get("tid") ?? "");
}
