import type { ContractStatus, Evidence, Finding, Report, Severity, StackItem, Vendor } from "../types.ts";

export interface RenderOpts {
  kind: "free" | "paid";
  bookUrl: string;
  /** Same-origin base for screenshots and the self-hosted font. */
  assetBase?: string;
}
export interface RenderExtras {
  reconciliation?: Array<{ conversion: string; system: string; truth: number; platform: number }>;
}

const CTA_LABEL = "Book the Tracking Audit";

/** Escape for HTML text and attributes. Also normalises dashes so no en/em dash ever reaches the output. */
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/[‒-―]/g, "-")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "..." : s;
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function assetUrl(base: string, ref: string): string | null {
  if (ref.split("/").some((s) => s === ".." || s === "")) return null;
  const b = base.replace(/\/+$/, "");
  return `${b}/${ref.split("/").map(encodeURIComponent).join("/")}`;
}

const SEV_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low"];
const STATUS_LABEL: Record<ContractStatus, { text: string; glyph: string }> = {
  ok: { text: "OK", glyph: "✓" },
  partial: { text: "Partial", glyph: "◐" },
  broken: { text: "Broken", glyph: "✕" },
  not_tracked: { text: "Not tracked", glyph: "○" },
  not_testable: { text: "Not testable", glyph: "?" },
};
const TYPE_LABEL: Record<string, string> = {
  purchase: "Purchase", lead: "Lead", booking: "Booking", signup: "Sign-up", contact_click: "Contact click", download: "Download",
};
const VENDOR_NAME: Partial<Record<Vendor, string>> = {
  ga4: "GA4", google_ads: "Google Ads", floodlight: "Floodlight", meta: "Meta", linkedin: "LinkedIn", tiktok: "TikTok", ms_uet: "Microsoft",
  gtm: "GTM", sgtm: "sGTM",
};

/* ---------------------------- setup map ---------------------------- */

interface MapNode { key: string; label: string; sub: string; col: number; row: number; x: number; y: number; ghost?: boolean }

function buildMap(report: Report, paid: boolean): string {
  const W = 900, NW = 176, NH = 46, ROWH = 66, TOP = 40;
  const cols = paid ? 4 : 3;
  const gap = (W - cols * NW - 24) / (cols - 1);
  const colX = (c: number) => 12 + c * (NW + gap);

  const byVendor = new Map<string, StackItem[]>();
  for (const s of report.stack) {
    if (s.vendor === "cmp" || s.vendor === "platform" || s.vendor === "other") continue;
    byVendor.set(s.vendor, [...(byVendor.get(s.vendor) ?? []), s]);
  }
  const idsOf = (v: string) => [...new Set((byVendor.get(v) ?? []).flatMap((s) => s.ids))];
  const has = (v: string) => byVendor.has(v);

  const tagKeys: string[] = [];
  if (has("gtm")) tagKeys.push("gtm");
  const gtagNamed = report.stack.some((s) => /gtag/i.test(s.name));
  if (gtagNamed || ((has("ga4") || has("google_ads")) && !has("gtm"))) tagKeys.push("gtag");
  if (has("sgtm")) tagKeys.push("sgtm");
  const destOrder: Vendor[] = ["ga4", "google_ads", "floodlight", "meta", "linkedin", "tiktok", "ms_uet"];
  const destKeys = destOrder.filter(has);

  const nodes: MapNode[] = [];
  const place = (keys: string[], col: number, label: (k: string) => string, sub: (k: string) => string, ghostText?: string) => {
    const list = keys.length ? keys : ghostText ? ["__ghost"] : [];
    list.forEach((k, i) => nodes.push({
      key: `${col}:${k}`, label: k === "__ghost" ? ghostText! : label(k), sub: k === "__ghost" ? "" : sub(k),
      col, row: i, x: colX(col), y: 0, ghost: k === "__ghost",
    }));
  };
  const host = (() => { try { return new URL(report.finalUrl).hostname; } catch { return report.target; } })();
  place(["site"], 0, () => "Site", () => host);
  const tagLabel: Record<string, string> = { gtm: "GTM", gtag: "gtag", sgtm: "sGTM" };
  place(tagKeys, 1, (k) => tagLabel[k]!, (k) => (k === "gtag" ? "" : idsOf(k)[0] ?? ""), "No tag layer seen");
  place(destKeys, 2, (k) => VENDOR_NAME[k as Vendor] ?? k, (k) => idsOf(k)[0] ?? "", "No destinations seen");
  if (paid) place(["truth"], 3, () => "Source of truth", () => "Orders, CRM, bookings");

  const maxRows = Math.max(...Array.from({ length: cols }, (_, c) => nodes.filter((n) => n.col === c).length), 1);
  const H = TOP + maxRows * ROWH + 8;
  for (let c = 0; c < cols; c++) {
    const col = nodes.filter((n) => n.col === c);
    const total = col.length * ROWH - (ROWH - NH);
    const start = TOP + ((maxRows * ROWH - (ROWH - NH)) - total) / 2;
    col.forEach((n, i) => (n.y = start + i * ROWH));
  }
  const node = (c: number, k: string) => nodes.find((n) => n.key === `${c}:${k}`);

  /* Findings per vendor: numbered pins. */
  const pinsFor = new Map<string, Array<{ n: number; id: string; title: string }>>();
  report.findings.forEach((f, i) => {
    if (!f.reproduced) return;
    for (const v of new Set(f.vendors)) {
      pinsFor.set(v, [...(pinsFor.get(v) ?? []), { n: i + 1, id: f.id, title: f.title }]);
    }
  });

  const edges: Array<{ from: MapNode; to: MapNode; broken: string[]; kind: "flow" | "truth" }> = [];
  const site = node(0, "site")!;
  const tagNodes = nodes.filter((n) => n.col === 1 && !n.ghost);
  const destNodes = nodes.filter((n) => n.col === 2 && !n.ghost);
  const pinKeysOfTag = (k: string) => (k === "gtag" ? [] : [k]);
  for (const t of tagNodes) {
    const k = t.key.split(":")[1]!;
    const src = k === "sgtm" && node(1, "gtm") ? node(1, "gtm")! : site;
    edges.push({ from: src, to: t, broken: pinKeysOfTag(k).flatMap((v) => (pinsFor.get(v) ?? []).map((p) => `${p.n}|${p.id}|${p.title}`)), kind: "flow" });
  }
  for (const d of destNodes) {
    const k = d.key.split(":")[1]!;
    const src = node(1, "gtm") ?? node(1, "gtag") ?? site;
    edges.push({ from: src, to: d, broken: (pinsFor.get(k) ?? []).map((p) => `${p.n}|${p.id}|${p.title}`), kind: "flow" });
    if (node(1, "sgtm") && (k === "ga4" || k === "meta")) {
      edges.push({ from: node(1, "sgtm")!, to: d, broken: [], kind: "flow" });
    }
  }
  if (paid) for (const d of destNodes) edges.push({ from: d, to: node(3, "truth")!, broken: [], kind: "truth" });

  const brokenNodes = new Set<string>();
  for (const e of edges) if (e.broken.length) brokenNodes.add(e.to.key);

  let svg = `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="map-t map-d" preserveAspectRatio="xMidYMid meet">`;
  svg += `<title id="map-t">Tracking setup map</title><desc id="map-d">Site, then tags, then destinations${paid ? ", then source of truth" : ""}. Dashed orange lines with numbered pins mark broken links, numbered as in the findings list.</desc>`;
  const heads = ["Site", "Tags", "Destinations", "Source of truth"];
  for (let c = 0; c < cols; c++) svg += `<text class="mh" x="${colX(c)}" y="20">${heads[c]!.toUpperCase()}</text>`;
  for (const e of edges) {
    const x1 = e.from.x + NW, y1 = e.from.y + NH / 2, x2 = e.to.x, y2 = e.to.y + NH / 2;
    const mx = (x1 + x2) / 2;
    const cls = e.broken.length ? "edge broken" : e.kind === "truth" ? "edge truth" : "edge";
    svg += `<path class="${cls}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`;
  }
  for (const n of nodes) {
    const cls = `node${n.ghost ? " ghost" : ""}${brokenNodes.has(n.key) ? " bad" : ""}`;
    svg += `<g class="${cls}"><rect x="${n.x}" y="${n.y}" width="${NW}" height="${NH}"/>`;
    svg += `<text class="nl" x="${n.x + 12}" y="${n.y + (n.sub ? 20 : 28)}">${esc(trunc(n.label, 22))}</text>`;
    if (n.sub) svg += `<text class="ns" x="${n.x + 12}" y="${n.y + 36}">${esc(trunc(n.sub, 26))}</text>`;
    svg += `</g>`;
  }
  for (const e of edges) {
    e.broken.slice(0, 3).forEach((b, i) => {
      const [num, id, title] = b.split("|") as [string, string, string];
      const px = e.to.x - 24 - i * 26;
      const py = e.to.y + NH / 2;
      svg += `<a href="#f-${esc(slug(id))}" class="pin"><title>Finding ${num}: ${esc(title)}</title><circle cx="${px}" cy="${py}" r="11"/><text x="${px}" y="${py + 4}" text-anchor="middle">${num}</text></a>`;
    });
  }
  svg += `</svg>`;

  const chips = report.stack
    .filter((s) => s.vendor === "cmp" || s.vendor === "platform")
    .map((s) => `<li><span class="lab">${s.vendor === "cmp" ? "Consent" : "Platform"}</span> ${esc(s.name)}</li>`)
    .join("");
  const textAlt = `<ul class="sr">${report.stack.map((s) => `<li>${esc(s.name)} ${esc(s.ids.join(", "))}</li>`).join("")}</ul>`;
  return `<div class="mapwrap" tabindex="0" role="group" aria-label="Setup map, scrolls sideways on small screens">${svg}</div>${textAlt}${chips ? `<ul class="chips">${chips}</ul>` : ""}`;
}

/* ---------------------------- evidence ---------------------------- */

function fmtVal(v: unknown): string {
  if (typeof v === "string") return trunc(v, 220);
  if (v === null || v === undefined) return String(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return trunc(JSON.stringify(v), 220); } catch { return "[unprintable]"; }
}
function kvTable(data: unknown): string {
  let rows: Array<[string, unknown]>;
  if (data && typeof data === "object" && !Array.isArray(data)) rows = Object.entries(data as Record<string, unknown>);
  else rows = [["value", data]];
  const more = rows.length > 16 ? rows.length - 16 : 0;
  rows = rows.slice(0, 16);
  return `<table class="kv"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${esc(trunc(k, 60))}</th><td>${esc(fmtVal(v))}</td></tr>`).join("")}${more ? `<tr><th scope="row">more</th><td>${more} more fields</td></tr>` : ""}</tbody></table>`;
}
const EV_LABEL: Record<Evidence["kind"], string> = {
  hit: "Network hit", datalayer: "dataLayer", cookie: "Cookie", screenshot: "Screenshot", html: "HTML", note: "Note",
};
function evidenceHtml(ev: Evidence, assetBase?: string): string {
  let body = "";
  if (ev.kind === "screenshot") {
    const u = assetBase && ev.ref ? assetUrl(assetBase, ev.ref) : null;
    body = u
      ? `<img src="${esc(u)}" alt="${esc(ev.caption)}" loading="lazy">`
      : `<p class="shotph">Screenshot is attached to the online report.</p>`;
  } else if (ev.data !== undefined) body = kvTable(ev.data);
  return `<figure class="ev"><figcaption><span class="lab">${EV_LABEL[ev.kind]}</span> ${esc(ev.caption)}</figcaption>${body}</figure>`;
}

/* ---------------------------- findings ---------------------------- */

const LOCK = `<svg class="lock" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

function findingHtml(f: Finding, n: number, open: boolean, report: Report, assetBase?: string): string {
  const sev = `<span class="sev s-${f.severity}">${SEV_LABEL[f.severity]}</span>`;
  const head = `<header><span class="num">${pad(n)}</span>${sev}${open ? "" : `<span class="lockmark">${LOCK} Locked</span>`}<h3>${esc(f.title)}</h3></header>`;
  let body = `<p class="why">${esc(f.why)}</p>`;
  if (open) {
    const note = report.rankNotes[f.id];
    if (note) body += `<p class="rank"><span class="lab">Why it ranks here</span> ${esc(note)}</p>`;
    if (f.evidence.length) body += `<div class="evs"><h4>Evidence</h4>${f.evidence.map((e) => evidenceHtml(e, assetBase)).join("")}</div>`;
    body += `<div class="fix"><h4>Fix</h4><p>${esc(f.fix.summary)}</p>${f.fix.steps.length ? `<ol>${f.fix.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}</div>`;
  } else {
    body += `<p class="lockedline">${LOCK} Evidence and fix are in the Tracking Audit.</p>`;
  }
  return `<article class="finding${open ? "" : " locked"}" id="f-${esc(slug(f.id))}" aria-labelledby="t-${esc(slug(f.id))}">${head.replace("<h3>", `<h3 id="t-${esc(slug(f.id))}">`)}${body}</article>`;
}

/* ---------------------------- reconciliation ---------------------------- */

function reconHtml(rows: NonNullable<RenderExtras["reconciliation"]>): string {
  const items = rows.map((r) => {
    const max = Math.max(r.truth, r.platform, 1);
    const gap = r.truth > 0 ? Math.round(((r.platform - r.truth) / r.truth) * 100) : null;
    const gapTxt = gap === null ? "n/a" : `${gap > 0 ? "+" : ""}${gap}%`;
    const big = gap !== null && Math.abs(gap) >= 10;
    return `<li class="rec"><div class="rh"><strong>${esc(r.conversion)}</strong> <span class="lab">${esc(r.system)}</span><span class="gap${big ? " big" : ""}">Gap ${gapTxt}</span></div>
<div class="bar"><span class="bl">Truth</span><span class="b t" style="width:${((r.truth / max) * 100).toFixed(1)}%"></span><span class="bv">${esc(r.truth)}</span></div>
<div class="bar"><span class="bl">Platform</span><span class="b p" style="width:${((r.platform / max) * 100).toFixed(1)}%"></span><span class="bv">${esc(r.platform)}</span></div></li>`;
  });
  return `<section aria-labelledby="h-rec"><h2 id="h-rec">Reconciliation</h2><p class="sub">Counts from your source of truth against what each platform reports. Gap is platform versus truth.</p><ul class="recs">${items.join("")}</ul></section>`;
}

/* ---------------------------- page ---------------------------- */

function css(assetBase?: string): string {
  const font = assetBase
    ? `@font-face{font-family:"Archivo Expanded";src:url("${esc(assetBase.replace(/\/+$/, ""))}/fonts/archivo-expanded.woff2") format("woff2");font-weight:800 900;font-display:swap}`
    : "";
  return `${font}
:root{--bg:#fff;--panel:#E6E6E6;--ink:#0A0A0A;--signal:#FF4D00;--signal-text:#B33600;--meta:#757575;--hair:#D4D4D4;
--display:"Archivo Expanded","Archivo","Helvetica Neue",Arial,sans-serif;--body:"Archivo","Helvetica Neue",Arial,system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:17px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:1080px;margin:0 auto;padding:0 16px 64px}
h1,h2,h3,h4{margin:0}
h1,h2{font-family:var(--display);font-stretch:125%;font-weight:800;text-transform:uppercase;line-height:.92;letter-spacing:-.01em}
h1{font-size:clamp(34px,8vw,84px);overflow-wrap:anywhere;margin:12px 0 20px}
h2{font-size:clamp(26px,4.4vw,44px);margin-bottom:20px}
h3{font-size:19px;line-height:1.25;font-weight:600}
h4{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:500;margin:16px 0 8px}
section{padding:40px 0 8px;border-top:2px solid var(--ink);margin-top:40px}
.lab{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--meta)}
.top{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:16px 0;border-bottom:2px solid var(--ink);flex-wrap:wrap}
.brand{font-weight:800;font-size:20px}
.meta{display:flex;flex-wrap:wrap;gap:8px 24px;margin:0;padding:0;list-style:none}
.meta li{font-family:var(--mono);font-size:13px}
.meta b{font-weight:500;color:var(--meta);text-transform:uppercase;letter-spacing:.08em;font-size:12px;margin-right:6px}
.badge{display:inline-block;border:2px solid var(--ink);padding:2px 10px;font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:2px solid var(--ink);margin:0 0 8px;padding:0;list-style:none}
.counts li{padding:14px 16px;border-right:2px solid var(--ink)}
.counts li:last-child{border-right:0}
.counts .n{display:block;font-family:var(--display);font-stretch:125%;font-weight:800;font-size:40px;line-height:1}
.counts li.c-critical{background:var(--signal)}
.counts li.c-critical .lab{color:var(--ink)}
.mapwrap{overflow-x:auto;border:2px solid var(--ink);padding:8px;background:var(--bg)}
.mapwrap:focus-visible,a:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.map{display:block;width:100%;min-width:640px;height:auto}
.map .mh{font-family:var(--mono);font-size:11px;letter-spacing:.08em;fill:var(--meta)}
.map .node rect{fill:var(--bg);stroke:var(--ink);stroke-width:2}
.map .node.bad rect{stroke:var(--signal);stroke-width:3.5}
.map .node.ghost rect{stroke-dasharray:4 4;stroke:var(--meta)}
.map .nl{font-family:var(--body);font-weight:600;font-size:14px;fill:var(--ink)}
.map .ns{font-family:var(--mono);font-size:10px;fill:var(--meta)}
.map .edge{fill:none;stroke:var(--ink);stroke-width:1.5}
.map .edge.truth{stroke:var(--meta);stroke-dasharray:2 4}
.map .edge.broken{stroke:var(--signal);stroke-width:3;stroke-dasharray:7 5}
.map .pin circle{fill:var(--signal);stroke:var(--ink);stroke-width:1.5}
.map .pin text{font-family:var(--mono);font-weight:500;font-size:12px;fill:var(--ink)}
.chips{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:12px 0 0}
.chips li{border:2px solid var(--ink);padding:3px 10px;font-size:14px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.convs{list-style:none;margin:0;padding:0;border-top:2px solid var(--ink)}
.conv{display:grid;grid-template-columns:150px 140px 1fr;gap:8px 16px;align-items:center;padding:12px 0;border-bottom:1px solid var(--hair);break-inside:avoid}
.conv .t{font-weight:600}
.st{display:inline-flex;gap:8px;align-items:center;font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;border:2px solid var(--ink);padding:3px 10px;width:fit-content}
.st.broken{background:var(--signal)}
.st.not_tracked,.st.not_testable{border-style:dashed}
.finding{border:2px solid var(--ink);padding:20px;margin:0 0 16px;break-inside:avoid}
.finding header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.finding header h3{flex-basis:100%;margin-top:6px}
.num{font-family:var(--mono);font-size:13px}
.sev{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:2px 10px;border:2px solid var(--ink)}
.s-critical{background:var(--signal)}
.s-high{background:var(--ink);color:#fff}
.s-low{color:var(--meta);border-color:var(--meta)}
.lockmark{display:inline-flex;gap:6px;align-items:center;font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--meta)}
.lock{vertical-align:-2px}
.finding.locked{border-style:dashed;border-color:var(--meta)}
.why{margin:10px 0 0;max-width:62ch}
.rank{margin:10px 0 0;max-width:62ch}
.lockedline{margin:10px 0 0;font-size:14px;color:var(--meta)}
.ev{margin:0 0 12px}
.ev figcaption{font-size:15px;margin-bottom:6px}
.ev img{max-width:100%;height:auto;border:2px solid var(--ink);display:block}
.shotph{margin:0;padding:12px;background:var(--panel);font-size:14px}
.kv{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12.5px;table-layout:fixed}
.kv th,.kv td{border:1px solid var(--hair);padding:5px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
.kv th{width:32%;background:var(--panel);font-weight:500}
.fix ol{margin:8px 0 0;padding-left:22px}
.fix p{margin:0}
.cta{background:var(--ink);color:#fff;padding:32px 24px;margin-top:24px;break-inside:avoid}
.cta h2{color:#fff;margin-bottom:12px}
.cta p{margin:0 0 20px;max-width:56ch}
.btn{display:inline-block;background:var(--signal);color:var(--ink);font-weight:800;text-decoration:none;padding:16px 24px;border:2px solid var(--signal);font-size:18px}
.btn:hover{background:#fff;border-color:#fff}
.sub{margin:-8px 0 20px;max-width:62ch}
.recs{list-style:none;margin:0;padding:0}
.rec{padding:14px 0;border-bottom:1px solid var(--hair);break-inside:avoid}
.rh{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;margin-bottom:8px}
.gap{margin-left:auto;font-family:var(--mono);font-size:13px;border:2px solid var(--ink);padding:1px 8px}
.gap.big{background:var(--signal)}
.bar{display:grid;grid-template-columns:70px 1fr 56px;align-items:center;gap:8px;margin:4px 0}
.bl{font-family:var(--mono);font-size:12px;color:var(--meta)}
.b{display:block;height:16px}
.b.t{background:var(--ink)}
.b.p{background:var(--panel);border:2px solid var(--ink);height:16px}
.bv{font-family:var(--mono);font-size:13px;text-align:right}
.foot{margin-top:48px;border-top:2px solid var(--ink);padding-top:16px;font-size:14px;color:var(--meta)}
@media (max-width:640px){
 body{font-size:16px}
 .counts{grid-template-columns:repeat(2,1fr)}
 .counts li:nth-child(2){border-right:0}
 .counts li:nth-child(-n+2){border-bottom:2px solid var(--ink)}
 .conv{grid-template-columns:1fr}
 .finding{padding:16px}
 .btn{display:block;text-align:center}
}
@media (prefers-reduced-motion:no-preference){.btn{transition:background-color .15s ease,border-color .15s ease}}
@page{size:A4;margin:14mm}
@media print{
 body{font-size:11pt}
 .page{max-width:none;padding:0}
 section{break-after:auto;margin-top:20px;padding-top:16px}
 h2,h3,h4{break-after:avoid}
 .finding,.conv,.rec,.cta,.ev,.kv{break-inside:avoid}
 .mapwrap{overflow:visible;border:2px solid var(--ink)}
 .map{min-width:0}
 .btn{border:2px solid var(--signal)}
 *{animation:none!important;transition:none!important}
}`;
}

export function renderReportHtml(report: Report, opts: RenderOpts, extras: RenderExtras = {}): string {
  const paid = opts.kind === "paid";
  const openIds = new Set(report.open);
  const isOpen = (f: Finding) => paid || openIds.has(f.id);
  const date = esc(report.generatedAt.slice(0, 10));
  const lockedCount = report.findings.filter((f) => !isOpen(f)).length;
  const total = report.findings.length;

  const counts = `<ul class="counts" aria-label="Findings by severity">${SEV_ORDER.map(
    (s) => `<li class="c-${s}"><span class="n">${report.counts[s] ?? 0}</span><span class="lab">${SEV_LABEL[s]}</span></li>`,
  ).join("")}</ul>`;

  const aborted = report.scan.aborted
    ? `<p class="why"><strong>The scan stopped early.</strong> ${esc(report.scan.aborted.detail)}</p>`
    : "";

  const convs = report.conversions.length
    ? `<ul class="convs">${report.conversions.map((c) => {
        const s = STATUS_LABEL[c.status];
        return `<li class="conv"><span class="t">${esc(TYPE_LABEL[c.type] ?? c.type)}</span><span class="st ${c.status}"><span aria-hidden="true">${s.glyph}</span>${s.text}</span><span>${esc(c.summary)}</span></li>`;
      }).join("")}</ul>`
    : `<p>No conversion points were found to test.</p>`;

  const findingsHtml = report.findings.map((f, i) => findingHtml(f, i + 1, isOpen(f), report, opts.assetBase)).join("");

  const cta = !paid
    ? `<aside class="cta" aria-labelledby="h-cta"><h2 id="h-cta">${lockedCount ? `${lockedCount} more to open` : "Go deeper"}</h2><p>${
        lockedCount ? "The Tracking Audit opens every finding with evidence and a fix for each." : "The Tracking Audit checks the server side and your real numbers."
      }</p><a class="btn" href="${esc(opts.bookUrl)}">${CTA_LABEL}</a></aside>`
    : "";

  const recon = paid && extras.reconciliation?.length ? reconHtml(extras.reconciliation) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(`Tracking ${paid ? "audit" : "scan"} ${report.target}`)}</title>
<style>${css(opts.assetBase)}</style>
</head>
<body>
<div class="page">
<div class="top"><span class="brand">Strativra</span><span class="badge">${paid ? "Tracking Audit" : "Free scan"}</span></div>
<header>
<h1>${esc(report.target)}</h1>
<ul class="meta"><li><b>Date</b>${date}</li><li><b>Scanned from</b>${esc(report.region)}</li><li><b>Report</b>${paid ? "Paid audit" : "Free scan"}</li><li><b>Pages</b>${esc(report.scan.pages)}</li></ul>
${aborted}
</header>

<section aria-labelledby="h-setup"><h2 id="h-setup">Your setup</h2>${buildMap(report, paid)}</section>

<section aria-labelledby="h-conv"><h2 id="h-conv">Conversions</h2>${convs}</section>

<section aria-labelledby="h-find"><h2 id="h-find">${total} finding${total === 1 ? "" : "s"}</h2>${counts}
<div class="list" style="margin-top:24px">${findingsHtml || "<p>No findings.</p>"}</div>
${cta}
</section>
${recon}
<p class="foot">We only see the browser side of server tagging and server events. Anything marked unknown stays unknown.</p>
</div>
</body>
</html>`;
}
