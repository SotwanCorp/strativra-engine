/**
 * Non-Google pixels: Meta, LinkedIn Insight, TikTok, Microsoft UET.
 * Advanced-matching / user data values are never kept, presence only.
 */
import type { CapturedRequest, DecodedHit } from "../../types.ts";
import {
  baseHit, cappedBody, hostIs, mergeQs, parseQs, redact, setNum, setStr, tryJson, type Params,
} from "./util.ts";

/* ------------------------------- Meta ------------------------------- */

export function isMeta(host: string, path: string): boolean {
  return hostIs(host, "facebook.com") && /^\/tr\/?$/.test(path);
}

/** Minimal multipart/form-data parser (Meta sometimes POSTs FormData). */
function parseMultipart(body: string): URLSearchParams | undefined {
  const first = body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first.startsWith("--")) return undefined;
  const out = new URLSearchParams();
  for (const part of body.split(first)) {
    const sep = /\r?\n\r?\n/.exec(part);
    if (!sep) continue;
    const head = part.slice(0, sep.index);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    const value = part.slice(sep.index + sep[0].length).replace(/\r?\n$/, "");
    out.append(name, value);
  }
  return out;
}

export function decodeMeta(req: CapturedRequest, url: URL, firstParty: boolean): DecodedHit[] {
  const body = cappedBody(req);
  let q = url.searchParams;
  if (body) q = mergeQs(q, parseMultipart(body) ?? parseQs(body));
  const hit = baseHit(req, "meta", q.get("ev") || "unknown", firstParty);
  const id = q.get("id");
  if (id) hit.accountId = id;
  const eid = q.get("eid");
  if (eid) hit.eventId = eid;
  const p = hit.params;
  let am = false;
  for (const [k, v] of q) {
    if (k.startsWith("ud[")) { am = true; continue; }
    const m = /^cd\[(.+)\]$/.exec(k);
    if (!m) continue;
    const name = m[1];
    if (name === "value") { setNum(p, "value", v); if (p.value === undefined) setStr(p, "value", v); continue; }
    const t = v.trim();
    if (t.startsWith("[")) {
      const arr = tryJson(t);
      if (Array.isArray(arr)) { p[name] = arr; continue; }
    }
    setStr(p, name, v);
  }
  if (am) p.advanced_matching = "present";
  setStr(p, "page_location", q.get("dl"));
  return [hit];
}

/* ----------------------------- LinkedIn ----------------------------- */

export function isLinkedIn(host: string, path: string): boolean {
  return hostIs(host, "px.ads.linkedin.com") && (path.startsWith("/collect") || path.startsWith("/wa"));
}

export function decodeLinkedIn(req: CapturedRequest, url: URL, firstParty: boolean): DecodedHit[] {
  const q = url.searchParams;
  let pid = q.get("pid") ?? "";
  let conv = q.get("conversionId") ?? "";
  const body = cappedBody(req);
  if (body) {
    const j = tryJson(body);
    if (j && typeof j === "object") {
      const o = j as Record<string, unknown>;
      if (!pid && Array.isArray(o.pids) && o.pids.length) pid = String(o.pids[0]);
      if (!pid && (typeof o.pid === "string" || typeof o.pid === "number")) pid = String(o.pid);
      if (!conv && (typeof o.conversionId === "string" || typeof o.conversionId === "number")) conv = String(o.conversionId);
    } else {
      const b = parseQs(body);
      pid ||= b.get("pid") ?? "";
      conv ||= b.get("conversionId") ?? "";
    }
  }
  const hit = baseHit(req, "linkedin", conv ? "conversion" : "page_view", firstParty);
  if (pid) hit.accountId = pid;
  if (conv) { hit.conversionLabel = conv; hit.params.conversion_id = conv; }
  setNum(hit.params, "value", q.get("value"));
  setStr(hit.params, "currency", q.get("currency"));
  return [hit];
}

/* ------------------------------ TikTok ------------------------------ */

export function isTikTok(host: string, path: string): boolean {
  return hostIs(host, "analytics.tiktok.com") && path.startsWith("/api/v2/pixel");
}

function tiktokOne(req: CapturedRequest, o: Record<string, unknown>, firstParty: boolean): DecodedHit {
  const ev = typeof o.event === "string" && o.event ? o.event : "unknown";
  const hit = baseHit(req, "tiktok", ev, firstParty);
  const ctx = (o.context && typeof o.context === "object" ? o.context : {}) as Record<string, unknown>;
  const pixel = (ctx.pixel && typeof ctx.pixel === "object" ? ctx.pixel : {}) as Record<string, unknown>;
  const code = typeof pixel.code === "string" ? pixel.code : typeof o.pixel_code === "string" ? o.pixel_code : undefined;
  if (code) hit.accountId = code;
  if (typeof o.event_id === "string" && o.event_id) hit.eventId = o.event_id;
  const p: Params = hit.params;
  const props = (o.properties && typeof o.properties === "object" ? o.properties : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "number" && Number.isFinite(v)) p[k] = v;
    else if (typeof v === "string") {
      if (k === "value") setNum(p, k, v);
      if (p[k] === undefined) setStr(p, k, v);
    } else if (Array.isArray(v)) p[k] = v;
  }
  const user = ctx.user;
  if (user && typeof user === "object" && Object.keys(user as object).some((k) => /email|phone|external_id/.test(k))) {
    p.advanced_matching = "present";
  }
  const page = ctx.page as Record<string, unknown> | undefined;
  if (page && typeof page.url === "string") p.page_location = redact(page.url);
  return hit;
}

export function decodeTikTok(req: CapturedRequest, _url: URL, firstParty: boolean): DecodedHit[] {
  const j = tryJson(cappedBody(req));
  if (!j || typeof j !== "object") return [];
  const o = j as Record<string, unknown>;
  if (Array.isArray(o.batch)) {
    return o.batch
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => tiktokOne(req, e, firstParty));
  }
  return [tiktokOne(req, o, firstParty)];
}

/* --------------------------- Microsoft UET --------------------------- */

export function isUet(host: string, path: string): boolean {
  return hostIs(host, "bat.bing.com") && path.startsWith("/action");
}

export function decodeUet(req: CapturedRequest, url: URL, firstParty: boolean): DecodedHit[] {
  const q = url.searchParams;
  const evt = q.get("evt") ?? "";
  const name = evt === "pageLoad" ? "page_view" : evt === "custom" ? q.get("ea") || "custom" : evt || "unknown";
  const hit = baseHit(req, "ms_uet", name, firstParty);
  const ti = q.get("ti");
  if (ti) hit.accountId = ti;
  const p = hit.params;
  setStr(p, "evt", evt);
  setStr(p, "event_action", q.get("ea"));
  setStr(p, "event_category", q.get("ec"));
  setStr(p, "event_label", q.get("el"));
  setNum(p, "event_value", q.get("ev"));
  setNum(p, "value", q.get("gv"));
  setStr(p, "currency", q.get("gc"));
  setStr(p, "page_location", q.get("p"));
  const asc = q.get("asc");
  if (asc) p.consent_asc = asc; // UET consent: G granted, D denied
  return [hit];
}
