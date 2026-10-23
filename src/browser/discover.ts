/**
 * Conversion point discovery (SPEC sections 2 and 3, step 1).
 *
 * discoverConversionPoints(page) reads the current page only (no clicks, no typing):
 * 1. one in-page snapshot (links, buttons, iframes, scripts, JSON-LD, adapter markers/globals),
 * 2. the scored form classifier (classify.ts) over the main frame and same-site iframes,
 * 3. adapters (adapters/*.ts) + generic rules, merged by a pure function (buildPoints).
 *
 * collectLinks(page) picks the key internal pages to visit next.
 */
import type { Page } from "playwright-core";
import type { ConversionPoint, ConversionType } from "../types.ts";
import type { AdapterHit, PageSnapshot, PointMeta } from "./adapters/types.ts";
import { ADAPTERS, detectPlatformHints, snapshotRequest } from "./adapters/index.ts";
import { classifyForms, formToConversion, type ClassifiedForm } from "./classify.ts";
import { isPaymentHost, isSameSite, safeUrl, shortHash } from "./adapters/hosts.ts";

/* ------------------------------------------------------------------ */
/* Point meta registry                                                  */
/* ------------------------------------------------------------------ */

/**
 * Walk hints for each discovered point, keyed by point id. Kept beside the
 * point because ConversionPoint has no meta field (see the proposed types change).
 * walk.ts falls back to inferring from the point when an id is missing.
 */
const META = new Map<string, PointMeta>();
export function pointMeta(id: string): PointMeta | undefined {
  return META.get(id);
}

/* ------------------------------------------------------------------ */
/* Shared regexes                                                       */
/* ------------------------------------------------------------------ */

export const ADD_TO_CART_RX =
  /\b(add to (cart|bag|basket)|ajouter au panier|in den warenkorb|a[nñ]adir al (carrito|carro)|aggiungi al carrello|toevoegen aan winkelwagen|adicionar ao carrinho)\b/i;

/** Labels of final steps. Nothing matching this is ever clicked. */
export const FINAL_STEP_RX =
  /\b(place (my |your )?order|pay( now)?|payer|complete (order|purchase|payment)|confirm|submit|send|subscribe|buy (it )?now|acheter maintenant|commander maintenant|valider (la |ma )?commande|jetzt kaufen|zahlungspflichtig|bestellen|kaufen|sign ?up|register|create (an |my |your )?account|book (now|it)|schedule (now|event))\b/i;

const CART_PATH_RX = /(^|\/)(cart|basket|panier|warenkorb|carrito|carrello)(\/|$|\.)/i;
const CHECKOUT_PATH_RX = /(^|\/)(checkouts?|kasse|commande|caisse)(\/|$|\.)/i;
const DOWNLOAD_RX = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|odt|ods|odp|rtf|rar|7z|epub|dmg|pkg|key|pages)$/i;
const WHATSAPP_RX = /^(https?:\/\/)?(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)\b|^whatsapp:/i;

/* ------------------------------------------------------------------ */
/* In-page snapshot (self-contained)                                    */
/* ------------------------------------------------------------------ */

export function snapshotInPage(args: { markers: string[]; globals: string[]; keywords: string[] }): PageSnapshot {
  // Keep in sync with cssPath in classify.ts (same algorithm, so selectors match).
  function cssPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id) && document.querySelectorAll("#" + cur.id).length === 1) {
        parts.unshift("#" + cur.id);
        break;
      }
      const tag = cur.tagName.toLowerCase();
      if (tag === "body") {
        parts.unshift("body");
        break;
      }
      let idx = 1;
      let same = false;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      sib = cur.nextElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) {
          same = true;
          break;
        }
        sib = sib.nextElementSibling;
      }
      parts.unshift(idx > 1 || same ? `${tag}:nth-of-type(${idx})` : tag);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }
  const clean = (s: string | null | undefined, max = 120) => (s || "").replace(/\s+/g, " ").trim().slice(0, max);
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content") || "";

  const jsonLdTypes: string[] = [];
  const walkLd = (node: unknown, depth: number) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const n of node) walkLd(n, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string") jsonLdTypes.push(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") jsonLdTypes.push(x);
    if (o["@graph"]) walkLd(o["@graph"], depth + 1);
  };
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20)) {
    try {
      walkLd(JSON.parse(s.textContent || ""), 0);
    } catch {
      /* invalid JSON-LD is ignored */
    }
  }

  const scriptEls = Array.from(document.scripts);
  const inline = scriptEls.filter((s) => !s.src).map((s) => (s.textContent || "").slice(0, 100000)).join("\n");
  const markers: PageSnapshot["markers"] = {};
  for (const m of args.markers) {
    try {
      const els = document.querySelectorAll(m);
      if (!els.length) continue;
      const first = els[0]!;
      const form = first instanceof HTMLFormElement ? first : first.closest("form");
      markers[m] = { count: els.length, selector: cssPath(first), ...(form ? { formSelector: cssPath(form) } : {}) };
    } catch {
      /* invalid selector in this engine */
    }
  }
  const w = window as unknown as Record<string, unknown>;
  return {
    url: location.href,
    title: document.title,
    bodyClass: (document.body?.className || "").toString().toLowerCase(),
    generator: meta('meta[name="generator"]'),
    ogType: meta('meta[property="og:type"]').toLowerCase(),
    jsonLdTypes,
    scripts: scriptEls.map((s) => s.src).filter(Boolean).slice(0, 300),
    iframes: Array.from(document.querySelectorAll("iframe")).slice(0, 60).map((f) => ({
      src: f.src || f.getAttribute("data-src") || "",
      selector: cssPath(f),
      title: clean(f.title, 80),
    })),
    links: Array.from(document.querySelectorAll("a[href]")).slice(0, 600).map((a) => ({
      href: (a as HTMLAnchorElement).href,
      text: clean((a as HTMLElement).innerText || a.getAttribute("aria-label") || a.getAttribute("title"), 80),
      selector: cssPath(a),
      inNav: !!a.closest("nav, header, [role=navigation], [role=banner]"),
      download: a.hasAttribute("download"),
    })),
    buttons: Array.from(
      document.querySelectorAll("button, input[type=submit], input[type=button], [role=button], a.add_to_cart_button, a.single_add_to_cart_button"),
    ).slice(0, 300).map((b) => {
      const form = (b as HTMLButtonElement).form || b.closest("form");
      return {
        tag: b.tagName.toLowerCase(),
        text: clean((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("aria-label"), 80),
        selector: cssPath(b),
        name: (b.getAttribute("name") || "").toLowerCase(),
        type: (b.getAttribute("type") || "").toLowerCase(),
        classes: (typeof b.className === "string" ? b.className : "").toLowerCase(),
        productId: ["data-product-id", "data-product_id", "data-productid", "data-variant-id"].some((x) => b.hasAttribute(x)),
        formAction: form ? form.action : "",
        href: b instanceof HTMLAnchorElement ? b.href : "",
      };
    }),
    forms: Array.from(document.forms).slice(0, 60).map((f) => ({
      action: f.action,
      selector: cssPath(f),
      classes: (typeof f.className === "string" ? f.className : "").toLowerCase(),
    })),
    markers,
    globals: args.globals.filter((g) => {
      try {
        return w[g] !== undefined && w[g] !== null;
      } catch {
        return false;
      }
    }),
    keywords: args.keywords.filter((k) => inline.includes(k)),
  };
}

/* ------------------------------------------------------------------ */
/* Generic rules (pure)                                                 */
/* ------------------------------------------------------------------ */

export function genericHits(s: PageSnapshot, siteHost: string): AdapterHit[] {
  const hits: AdapterHit[] = [];
  const sameSiteHttp = (href: string) => {
    const u = safeUrl(href);
    return !!u && /^https?:$/.test(u.protocol) && isSameSite(u.hostname, siteHost);
  };

  // purchase: add to cart > product page > cart/checkout link
  const productPage = s.jsonLdTypes.some((t) => /^(schema:)?(Product|ProductGroup)$/i.test(t)) || /^(og:)?product/.test(s.ogType);
  const cartLink = s.links.find((l) => sameSiteHttp(l.href) && CART_PATH_RX.test(safeUrl(l.href)!.pathname) && !/clear|empty|remove/i.test(l.href));
  const checkoutLink = s.links.find((l) => sameSiteHttp(l.href) && CHECKOUT_PATH_RX.test(safeUrl(l.href)!.pathname));
  const atc =
    s.buttons.find((b) => ADD_TO_CART_RX.test(b.text) && !FINAL_STEP_RX.test(b.text)) ??
    s.buttons.find(
      (b) =>
        !FINAL_STEP_RX.test(b.text) &&
        (b.name === "add-to-cart" || b.productId || (/\/cart\/add/.test(b.formAction) && (b.type === "submit" || b.tag === "button"))),
    );
  const cartUrl = cartLink?.href;
  if (atc) {
    hits.push({
      type: "purchase",
      label: productPage ? "Add to cart on a product page" : "Add to cart button",
      selector: atc.selector,
      confidence: productPage ? 0.95 : 0.85,
      key: "purchase:add_to_cart",
      meta: { purchase: "add_to_cart", productPage, walkable: true, ...(cartUrl ? { cartUrl } : {}) },
    });
  } else if (productPage) {
    hits.push({
      type: "purchase",
      label: "Product page (no add to cart button found)",
      confidence: 0.6,
      key: "purchase:product_page",
      meta: { purchase: "product_page", productPage: true, walkable: true, ...(cartUrl ? { cartUrl } : {}) },
    });
  } else if (cartLink || checkoutLink) {
    const l = (cartLink ?? checkoutLink)!;
    hits.push({
      type: "purchase",
      label: cartLink ? "Cart link" : "Checkout link",
      selector: l.selector,
      confidence: 0.5,
      key: "purchase:cart_link",
      meta: { purchase: "cart_link", walkable: true, cartUrl: l.href, href: l.href },
    });
  }

  // contact clicks: one point per channel
  const firstLink = (test: (href: string) => boolean) => s.links.find((l) => test(l.href));
  const tel = firstLink((h) => /^(tel|sms|callto):/i.test(h));
  if (tel) hits.push({ type: "contact_click", label: "Phone link", selector: tel.selector, confidence: 0.95, key: "contact_click:phone", meta: { channel: "phone", href: tel.href, walkable: true } });
  const mail = firstLink((h) => /^mailto:/i.test(h));
  if (mail) hits.push({ type: "contact_click", label: "Email link", selector: mail.selector, confidence: 0.95, key: "contact_click:email", meta: { channel: "email", href: mail.href, walkable: true } });
  const wa = firstLink((h) => WHATSAPP_RX.test(h));
  if (wa) hits.push({ type: "contact_click", label: "WhatsApp link", selector: wa.selector, confidence: 0.9, key: "contact_click:whatsapp", meta: { channel: "whatsapp", vendor: "WhatsApp", href: wa.href, walkable: true } });

  // downloads (record only), max 5 distinct files
  const seen = new Set<string>();
  for (const l of s.links) {
    const u = safeUrl(l.href);
    if (!u || !/^https?:$/.test(u.protocol)) continue;
    if (!(DOWNLOAD_RX.test(u.pathname) || l.download)) continue;
    const key = u.origin + u.pathname;
    if (seen.has(key) || seen.size >= 5) continue;
    seen.add(key);
    const file = decodeURIComponent(u.pathname.split("/").pop() || "file");
    hits.push({ type: "download", label: `Download link (${file.slice(0, 60)})`, selector: l.selector, confidence: 0.9, key: `download:${key}`, meta: { href: l.href, walkable: true } });
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* Merge (pure)                                                         */
/* ------------------------------------------------------------------ */

const FORM_LABEL: Record<string, string> = { contact: "Contact form", signup: "Sign-up form", newsletter: "Newsletter form" };

function pageKey(url: string): string {
  const u = safeUrl(url);
  return u ? u.origin + u.pathname : url;
}

export interface BuiltPoint {
  point: ConversionPoint;
  meta: PointMeta;
}

/**
 * Merge adapter hits, generic hits and classified forms into points.
 * - adapter hits win over generic hits with the same key;
 * - DOM form adapters (formSelector) only relabel a classified form; they drop it
 *   when the classifier says login/search/checkout;
 * - only contact, signup and newsletter forms become points.
 */
export function buildPoints(
  s: PageSnapshot,
  forms: ClassifiedForm[],
  adapterHits: Array<AdapterHit & { adapterId: string }>,
  siteHost: string,
): BuiltPoint[] {
  const pageUrl = s.url;
  const out = new Map<string, BuiltPoint>();
  const mk = (type: ConversionType, key: string, h: Omit<ConversionPoint, "id" | "type" | "pageUrl" | "walk">, meta: PointMeta) => {
    const id = `${type}-${shortHash(pageKey(pageUrl) + "|" + key)}`;
    if (out.has(key)) return;
    out.set(key, { point: { id, type, pageUrl, walk: [], ...h }, meta });
  };

  const formAdapterBySel = new Map<string, AdapterHit & { adapterId: string }>();
  for (const h of adapterHits) if (h.formSelector) formAdapterBySel.set(h.formSelector, h);

  // 1. adapter hits (non-form-interpreting)
  for (const h of adapterHits) {
    if (h.formSelector && h.meta.embed === "dom") continue;
    mk(h.type, h.key, { label: h.label, selector: h.selector, detectedBy: h.adapterId, confidence: h.confidence }, h.meta);
  }
  // 2. generic hits
  for (const h of genericHits(s, siteHost)) {
    if (h.key === "purchase:product_page" || h.key === "purchase:cart_link") {
      if (out.has("purchase:add_to_cart")) continue;
    }
    mk(h.type, h.key, { label: h.label, selector: h.selector, detectedBy: "generic", confidence: h.confidence }, h.meta);
  }
  // 3. forms
  const usedAdapterForms = new Set<string>();
  for (const f of forms) {
    const ad = f.frameUrl ? undefined : formAdapterBySel.get(f.selector);
    if (ad) usedAdapterForms.add(f.selector);
    const conv = formToConversion(f.kind, f.confidence);
    if (!conv) {
      // A form builder form the classifier could not place (and not login/search/checkout): weak lead.
      if (ad && f.kind === "unknown") {
        mk("lead", `form:${f.selector}`, { label: `${ad.meta.vendor ?? "Form"} (${f.fields} fields)`, selector: f.selector, detectedBy: ad.adapterId, confidence: 0.5 }, { ...ad.meta, formKind: f.kind });
      }
      continue;
    }
    const base = FORM_LABEL[f.kind] ?? "Form";
    const label = ad ? `${base} (${ad.meta.vendor}, ${f.fields} fields)` : `${base} (${f.fields} fields)${f.frameUrl ? " in an iframe" : ""}`;
    const meta: PointMeta = { walkable: true, embed: "dom", formKind: f.kind, ...(ad ? { vendor: ad.meta.vendor } : {}), ...(f.frameUrl ? { frameUrl: f.frameUrl } : {}) };
    const key = `form:${f.frameUrl ?? ""}:${f.selector}`;
    mk(conv.type, key, { label, selector: f.selector, detectedBy: ad ? ad.adapterId : "generic", confidence: ad ? Math.max(conv.confidence, Math.min(0.97, conv.confidence + 0.05)) : conv.confidence }, meta);
  }
  // 4. form builder forms not seen by the classifier (selector mismatch): weak lead.
  for (const [sel, ad] of formAdapterBySel) {
    if (usedAdapterForms.has(sel) || ad.meta.embed !== "dom") continue;
    mk("lead", `form:${sel}`, { label: ad.label, selector: sel, detectedBy: ad.adapterId, confidence: 0.5 }, ad.meta);
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ */
/* Browser entry points                                                 */
/* ------------------------------------------------------------------ */

export interface PageDiscovery {
  points: ConversionPoint[];
  platformHints: string[];
  forms: ClassifiedForm[];
  snapshot: PageSnapshot | null;
}

/** Full discovery result for the current page (points + platform hints + classified forms). */
export async function discoverPage(page: Page, opts: { siteHost: string }): Promise<PageDiscovery> {
  let snapshot: PageSnapshot | null = null;
  try {
    snapshot = await page.mainFrame().evaluate(snapshotInPage, snapshotRequest());
  } catch {
    return { points: [], platformHints: [], forms: [], snapshot: null };
  }
  const forms = await classifyForms(page, opts.siteHost);
  const hits: Array<AdapterHit & { adapterId: string }> = [];
  for (const a of ADAPTERS) {
    try {
      for (const h of a.detect(snapshot)) hits.push({ ...h, adapterId: a.id });
    } catch {
      /* an adapter bug never breaks discovery */
    }
  }
  const built = buildPoints(snapshot, forms, hits, opts.siteHost);
  for (const b of built) META.set(b.point.id, b.meta);
  return { points: built.map((b) => b.point), platformHints: detectPlatformHints(snapshot), forms, snapshot };
}

export async function discoverConversionPoints(page: Page, opts: { siteHost: string }): Promise<ConversionPoint[]> {
  return (await discoverPage(page, opts)).points;
}

/* ------------------------------------------------------------------ */
/* Link picking                                                         */
/* ------------------------------------------------------------------ */

export interface RawLink {
  href: string;
  text: string;
  inNav: boolean;
}

const EXCLUDE_RX =
  /(log-?out|sign-?out|log-?in|sign-?in|wp-admin|wp-login|\/admin\b|\/account\b|my-account|\/user\/|cart\/clear|clear-?cart|empty-?cart|add-to-cart=|remove|unsubscribe|\/feed\/?$|\/cdn-cgi\/)/i;
const SKIP_EXT_RX = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|jpe?g|png|gif|webp|svg|mp4|mp3|webm|avif|ico|xml|json|txt|rss)$/i;

const PRIORITY: Array<{ cat: string; rx: RegExp }> = [
  { cat: "contact", rx: /(contact|kontakt|contactez|get-in-touch|nous-joindre)/i },
  { cat: "booking", rx: /(\bbook|booking|appointment|rendez-vous|\brdv\b|schedule|reservation|termin)/i },
  { cat: "product", rx: /\/(products?|produits?|produkt|item|p)\/[^/]+/i },
  { cat: "shop", rx: /\/(shop|store|boutique|collections?|catalog|catalogue)(\/|$)/i },
  { cat: "cart", rx: /\/(cart|basket|panier|warenkorb)(\/|$|\.)/i },
  { cat: "signup", rx: /(sign-?up|register|get-started|\btrial\b|inscription|registrieren|create-account)/i },
  { cat: "about", rx: /(about|a-propos|qui-sommes|ueber-uns|uber-uns|about-us)/i },
];

/** Pure: pick up to max key internal pages from raw links. */
export function pickLinks(links: RawLink[], currentUrl: string, siteHost: string, max: number): string[] {
  const norm = (u: URL) => {
    const c = new URL(u.href);
    c.hash = "";
    let s = c.href;
    if (s.endsWith("/") && c.pathname !== "/") s = s.slice(0, -1);
    return s;
  };
  const cur = safeUrl(currentUrl);
  const curKey = cur ? norm(cur) : "";
  const seen = new Set<string>([curKey]);
  const ok: Array<{ url: string; text: string; inNav: boolean; path: string }> = [];
  for (const l of links) {
    const u = safeUrl(l.href, currentUrl);
    if (!u || !/^https?:$/.test(u.protocol)) continue;
    if (!isSameSite(u.hostname, siteHost) || isPaymentHost(u.hostname)) continue;
    const path = u.pathname + u.search;
    if (EXCLUDE_RX.test(path) || EXCLUDE_RX.test(l.text.replace(/\s+/g, "-")) || SKIP_EXT_RX.test(u.pathname)) continue;
    const key = norm(u);
    if (seen.has(key)) continue;
    seen.add(key);
    ok.push({ url: key, text: l.text, inNav: l.inNav, path: decodeURIComponent(u.pathname) });
  }
  const picked: string[] = [];
  const take = (url: string) => {
    if (picked.length < max && !picked.includes(url)) picked.push(url);
  };
  for (const p of PRIORITY) {
    const m = ok.find((l) => p.rx.test(l.path)) ?? ok.find((l) => p.rx.test(l.text.toLowerCase().replace(/\s+/g, "-")));
    if (m) take(m.url);
  }
  for (const l of ok) if (l.inNav) take(l.url);
  return picked;
}

export async function collectLinks(page: Page, siteHost: string, max: number): Promise<string[]> {
  let links: RawLink[] = [];
  try {
    links = await page.mainFrame().evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).slice(0, 1500).map((a) => ({
        href: (a as HTMLAnchorElement).href,
        text: ((a as HTMLElement).innerText || a.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80),
        inNav: !!a.closest("nav, header, [role=navigation], [role=banner]"),
      })),
    );
  } catch {
    return [];
  }
  return pickLinks(links, page.url(), siteHost, max);
}
