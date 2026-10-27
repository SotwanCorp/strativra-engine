/**
 * Safe funnel walks (SPEC section 3, step 3): walk each conversion path up to, but never
 * including, the final submit or payment, so we can see whether the steps before it are tracked.
 *
 * Safety, on top of the runner's network blocks (non-tracking POSTs, payment endpoints):
 * - We never click a submit/pay/order/subscribe control: every click target is checked against
 *   FINAL_STEP_RX first, and form walks never click at all.
 * - We never type an email, phone, password or card: only "test" into the first plain text input
 *   or textarea, via locator.fill (no key presses, so no Enter).
 * - During each walk a page-level route guard (page.route + route.fallback, so the runner's
 *   context routes still apply) aborts navigations we did not intend: off-site and payment hosts
 *   always, any non-GET navigation during form walks, and every top-level navigation during
 *   contact clicks. A submit guard in the form's frame cancels submit events and form.submit().
 *   Popups opened during a walk are closed.
 * - Budget: about 25 s per scenario, max 2 points per type, short per-action timeouts.
 *   Failures are recorded as ok=false, never thrown.
 */
import type { Frame, Page, Route } from "playwright-core";
import type { ConversionPoint, ConversionType, FunnelStep, PageVisit, Scenario } from "../types.ts";
import type { PointMeta } from "./adapters/types.ts";
import { isPaymentHost, isSameSite, safeUrl } from "./adapters/hosts.ts";
import { ADD_TO_CART_RX, FINAL_STEP_RX, pointMeta } from "./discover.ts";

export interface WalkContext {
  scenario: Scenario;
  startedAt: number;
  siteHost: string;
}

export interface WalkOptions {
  /** Total budget in ms (default 25000). */
  budgetMs?: number;
  /** Max points walked per conversion type (default 2). */
  maxPerType?: number;
}

const TYPE_ORDER: ConversionType[] = ["contact_click", "download", "booking", "lead", "signup", "purchase"];
const SAFE_TEXT = "test";
const UNSAFE_FIELD_RX =
  /mail|courriel|phone|\btel\b|mobile|portable|handy|whatsapp|passw|passwort|mot de passe|card|\bcc-|iban|cvv|cvc|\bzip\b|postal|otp|\bcode\b|captcha|user ?name|\blogin\b|search|\bq\b|siret|vat|tax|ssn|birth/i;

class Budget {
  readonly deadline: number;
  constructor(ms: number) {
    this.deadline = Date.now() + ms;
  }
  left(): number {
    return this.deadline - Date.now();
  }
  t(max = 3000): number {
    return Math.max(300, Math.min(max, this.left()));
  }
}

interface Walker {
  page: Page;
  ctx: WalkContext;
  budget: Budget;
  steps: FunnelStep[];
  visits: PageVisit[];
}

function sameDoc(a: string, b: string): boolean {
  const x = safeUrl(a);
  const y = safeUrl(b);
  if (!x || !y) return a === b;
  x.hash = "";
  y.hash = "";
  return x.href === y.href;
}

function step(w: Walker, point: ConversionPoint, name: string, action: string, ok: boolean): void {
  const s: FunnelStep = { name, action, ok, pageUrl: w.page.url(), ts: Date.now() - w.ctx.startedAt, scenario: w.ctx.scenario };
  point.walk.push(s);
  w.steps.push(s);
}

async function visit(w: Walker, status: number | null): Promise<void> {
  let title: string | undefined;
  try {
    title = await w.page.title();
  } catch {
    title = undefined;
  }
  w.visits.push({ url: w.page.url(), status, via: "funnel", ...(title ? { title } : {}) });
}

async function goTo(w: Walker, url: string): Promise<boolean> {
  if (sameDoc(w.page.url(), url)) return true;
  try {
    const resp = await w.page.goto(url, { waitUntil: "domcontentloaded", timeout: w.budget.t(8000) });
    const status = resp ? resp.status() : null;
    await visit(w, status);
    return status === null || status < 400;
  } catch {
    return false;
  }
}

type GuardMode = "purchase" | "form" | "click";

/**
 * Run fn with a page-level navigation guard. page.route handlers run before the runner's
 * context.route handlers; we call route.fallback() for everything we do not abort, so the
 * runner's own blocking and recording still apply.
 */
async function guarded<T>(w: Walker, mode: GuardMode, fn: () => Promise<T>): Promise<T> {
  const page = w.page;
  const handler = async (route: Route) => {
    const req = route.request();
    let abort = false;
    try {
      if (req.isNavigationRequest()) {
        const main = req.frame() === page.mainFrame();
        const u = safeUrl(req.url());
        const offsite = !u || !/^https?:$/.test(u.protocol) || !isSameSite(u.hostname, w.ctx.siteHost) || isPaymentHost(u.hostname);
        if (mode === "purchase") abort = main && offsite;
        else if (mode === "form") abort = req.method() !== "GET" || (main && offsite);
        else abort = main;
      }
    } catch {
      abort = false;
    }
    if (abort) await route.abort("blockedbyclient").catch(() => {});
    else await route.fallback().catch(() => {});
  };
  const closePopup = (p: Page) => {
    void p.close().catch(() => {});
  };
  await page.route("**/*", handler);
  page.on("popup", closePopup);
  try {
    return await fn();
  } finally {
    page.off("popup", closePopup);
    await page.unroute("**/*", handler).catch(() => {});
  }
}

/** Infer walk hints when the point did not come from discover.ts in this process. */
function metaFor(p: ConversionPoint): PointMeta {
  const m = pointMeta(p.id);
  if (m) return m;
  const label = p.label.toLowerCase();
  const inferred: PointMeta = { walkable: !/stripe|hosted checkout/.test(label) };
  if (p.type === "contact_click") {
    inferred.channel = /phone/.test(label) ? "phone" : /email/.test(label) ? "email" : /whatsapp/.test(label) ? "whatsapp" : "chat";
  }
  if (p.type === "purchase") inferred.purchase = /add to cart/.test(label) ? "add_to_cart" : /product/.test(label) ? "product_page" : "cart_link";
  return inferred;
}

/* ------------------------------------------------------------------ */
/* Per-type walks                                                       */
/* ------------------------------------------------------------------ */

async function walkContactClick(w: Walker, p: ConversionPoint, m: PointMeta): Promise<void> {
  if (m.channel === "chat" || !p.selector) {
    step(w, p, "chat_detected", "chat widget detected, not opened", true);
    return;
  }
  const page = w.page;
  const before = page.url();
  /*
   * Navigation prevention for tel:/mailto:/WhatsApp clicks.
   * We install ONE click listener on window in the BUBBLE phase. Event order for a click on the
   * link is: window capture, document capture (GTM's link click listener), ..., the link's own
   * handlers, then bubbling up to document (GTM/gtag listeners registered in bubble) and finally
   * window. So every site and tag manager listener sees a normal, cancellable click first, and only
   * then we call preventDefault() so the browser does not follow the link. If a site handler stops
   * propagation, our listener never runs; the page route guard (mode "click") then aborts any
   * top-level navigation, and tel:/mailto: have no navigation in headless Chromium anyway.
   */
  try {
    await page.evaluate(() => {
      const w = window as unknown as { __strativraClicks?: string[] };
      if (w.__strativraClicks) return;
      w.__strativraClicks = [];
      window.addEventListener(
        "click",
        (e) => {
          const t = e.target as Element | null;
          const a = t && typeof t.closest === "function" ? (t.closest("a[href]") as HTMLAnchorElement | null) : null;
          if (!a) return;
          const href = a.getAttribute("href") || "";
          if (/^(tel|mailto|sms|callto|whatsapp):/i.test(href) || /(wa\.me|whatsapp\.com)/i.test(href)) {
            e.preventDefault();
            w.__strativraClicks!.push(href);
          }
        },
        false,
      );
    });
  } catch {
    step(w, p, "click", "could not prepare click guard", false);
    return;
  }
  await guarded(w, "click", async () => {
    const loc = page.locator(p.selector!).first();
    let how = "clicked";
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: w.budget.t(2000) });
      await loc.click({ timeout: w.budget.t(2000), noWaitAfter: true });
    } catch {
      try {
        await loc.dispatchEvent("click", undefined, { timeout: w.budget.t(1500) });
        how = "dispatched click on";
      } catch {
        step(w, p, "click", `could not click ${m.channel ?? "contact"} link`, false);
        return;
      }
    }
    await page.waitForTimeout(Math.min(500, Math.max(0, w.budget.left())));
    let seen = false;
    try {
      seen = await page.evaluate(() => ((window as unknown as { __strativraClicks?: string[] }).__strativraClicks ?? []).length > 0);
    } catch {
      seen = false;
    }
    const stayed = sameDoc(page.url(), before);
    step(w, p, "click", `${how} ${m.channel ?? "contact"} link (navigation prevented)`, stayed && (seen || how === "clicked"));
  });
}

async function walkBooking(w: Walker, p: ConversionPoint, m: PointMeta): Promise<void> {
  if (!p.selector) {
    step(w, p, "booking_view", `${m.vendor ?? "booking"} script found, no embed to view`, false);
    return;
  }
  try {
    await w.page.locator(p.selector).first().scrollIntoViewIfNeeded({ timeout: w.budget.t(2500) });
    await w.page.waitForTimeout(Math.min(400, Math.max(0, w.budget.left())));
    step(w, p, "booking_view", m.embed === "link" ? "scrolled booking link into view, not followed" : "scrolled booking embed into view, no interaction inside", true);
  } catch {
    step(w, p, "booking_view", "booking embed not visible", false);
  }
}

function formFrame(page: Page, m: PointMeta): Frame {
  if (m.frameUrl) {
    const f = page.frames().find((fr) => fr.url() === m.frameUrl);
    if (f) return f;
  }
  return page.mainFrame();
}

async function walkForm(w: Walker, p: ConversionPoint, m: PointMeta): Promise<void> {
  if (!p.selector) {
    step(w, p, "form_view", "form has no selector", false);
    return;
  }
  const frame = formFrame(w.page, m);
  const root = frame.locator(p.selector).first();
  try {
    await root.scrollIntoViewIfNeeded({ timeout: w.budget.t(2500) });
    step(w, p, "form_view", "scrolled form into view", true);
  } catch {
    step(w, p, "form_view", "form not visible", false);
    return;
  }
  // Cross-origin embeds (Typeform, HubSpot iframe, Tally...) and links: view only.
  if (m.embed && m.embed !== "dom") return;

  await guarded(w, "form", async () => {
    let picked: string | null = null;
    try {
      picked = await root.evaluate((el, unsafeSrc) => {
        const unsafe = new RegExp(unsafeSrc, "i");
        // Submit guard: cancel any submit in this frame and neuter form.submit() while we scan.
        const win = window as unknown as { __strativraNoSubmit?: boolean };
        if (!win.__strativraNoSubmit) {
          win.__strativraNoSubmit = true;
          document.addEventListener("submit", (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
          HTMLFormElement.prototype.submit = function () { /* blocked by scanner */ };
          HTMLFormElement.prototype.requestSubmit = function () { /* blocked by scanner */ };
        }
        const fields = Array.from(el.querySelectorAll("input, textarea")) as Array<HTMLInputElement | HTMLTextAreaElement>;
        for (const f of fields) {
          if (f.disabled || f.readOnly) continue;
          if (f instanceof HTMLInputElement) {
            const t = (f.getAttribute("type") || "text").toLowerCase();
            if (t !== "text") continue;
          }
          const labels = (f as HTMLInputElement).labels;
          const d = [f.name, f.id, f.getAttribute("autocomplete"), f.getAttribute("placeholder"), f.getAttribute("aria-label"), labels && labels[0] ? labels[0].textContent : ""].join(" ");
          if (unsafe.test(d)) continue;
          const r = f.getBoundingClientRect();
          const st = getComputedStyle(f);
          if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none") continue;
          f.setAttribute("data-strativra-target", "1");
          return (f.name || f.id || f.tagName).toLowerCase();
        }
        return null;
      }, UNSAFE_FIELD_RX.source);
    } catch {
      picked = null;
    }
    if (!picked) {
      step(w, p, "form_start", "no safe text field (only email, phone or password fields), nothing typed", false);
      return;
    }
    const target = frame.locator("[data-strativra-target]").first();
    try {
      await target.focus({ timeout: w.budget.t(1500) });
      await target.fill(SAFE_TEXT, { timeout: w.budget.t(1500) }); // fill: no key presses, never Enter
      await target.blur({ timeout: w.budget.t(1000) });
      await w.page.waitForTimeout(Math.min(400, Math.max(0, w.budget.left())));
      step(w, p, "form_start", `typed "${SAFE_TEXT}" in the ${picked} field and left it, not submitted`, true);
    } catch {
      step(w, p, "form_start", `could not type in the ${picked} field`, false);
    } finally {
      await target.evaluate((el) => el.removeAttribute("data-strativra-target")).catch(() => {});
    }
  });
}

async function walkPurchase(w: Walker, p: ConversionPoint, m: PointMeta): Promise<void> {
  const page = w.page;
  if (m.walkable === false || m.purchase === "hosted_checkout") {
    step(w, p, "checkout_link", `${m.vendor ?? "hosted"} checkout link found, not followed`, true);
    return;
  }
  await guarded(w, "purchase", async () => {
    if (m.purchase === "add_to_cart" || m.purchase === "product_page") {
      step(w, p, "view_item", m.productPage === false ? "loaded page with add to cart" : "loaded product page", true);
    }
    if (m.purchase === "add_to_cart" && p.selector) {
      const btn = page.locator(p.selector).first();
      let text = "";
      try {
        text = ((await btn.innerText({ timeout: w.budget.t(1500) })) || (await btn.getAttribute("value")) || "").trim();
      } catch {
        text = "";
      }
      if (FINAL_STEP_RX.test(text) && !ADD_TO_CART_RX.test(text)) {
        step(w, p, "add_to_cart", `skipped "${text.slice(0, 40)}": looks like a final step`, false);
        return;
      }
      try {
        await btn.scrollIntoViewIfNeeded({ timeout: w.budget.t(2000) });
        await btn.click({ timeout: w.budget.t(2500) }); // one click, quantity untouched
        await page.waitForTimeout(Math.min(1500, Math.max(0, w.budget.left())));
        step(w, p, "add_to_cart", "clicked add to cart once", true);
      } catch {
        step(w, p, "add_to_cart", "could not click add to cart", false);
        return;
      }
    }
    if (w.budget.left() < 2000) return;

    // Cart
    const origin = safeUrl(page.url())?.origin ?? safeUrl(p.pageUrl)?.origin ?? "";
    let cartUrl = m.cartUrl;
    if (!cartUrl) {
      cartUrl = await page
        .evaluate(() => {
          const a = Array.from(document.querySelectorAll("a[href]")).find((x) =>
            /(^|\/)(cart|basket|panier|warenkorb)(\/|$|\.)/i.test(new URL((x as HTMLAnchorElement).href, location.href).pathname),
          ) as HTMLAnchorElement | undefined;
          return a ? a.href : "";
        })
        .catch(() => "");
      if (!cartUrl) cartUrl = origin + "/cart";
    }
    const cu = safeUrl(cartUrl);
    if (!cu || !isSameSite(cu.hostname, w.ctx.siteHost)) {
      step(w, p, "view_cart", "cart is not on this site, stopped", false);
      return;
    }
    const cartOk = await goTo(w, cu.href);
    step(w, p, "view_cart", "opened the cart page", cartOk);
    if (!cartOk || w.budget.left() < 1500) return;

    // Checkout: find the control, check where it leads, click once, stop when the page loads.
    const found = await page
      .evaluate(() => {
        const RX = /(proceed to |go to |continue to )?check ?out|zur kasse|passer (à|a) la (caisse|commande)|^commander$|finalizar compra|tramitar pedido|vai alla cassa/i;
        const PATH = /(^|\/)(checkouts?|kasse|commande|caisse)(\/|$|\.)/i;
        const els = Array.from(document.querySelectorAll("a[href], button, input[type=submit], [role=button]")) as HTMLElement[];
        const text = (el: HTMLElement) => (el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        const byHref = els.find((el) => el instanceof HTMLAnchorElement && PATH.test(new URL(el.href, location.href).pathname));
        const byText = els.find((el) => RX.test(text(el)) || el.getAttribute("name") === "checkout");
        const el = byHref ?? byText;
        if (!el) return null;
        el.setAttribute("data-strativra-checkout", "1");
        const form = (el as HTMLButtonElement).form ?? el.closest("form");
        return {
          text: text(el).slice(0, 60),
          href: el instanceof HTMLAnchorElement ? el.href : "",
          formAction: form ? form.action : "",
        };
      })
      .catch(() => null);
    if (!found) {
      step(w, p, "begin_checkout", "no checkout button found on the cart page", false);
      return;
    }
    if (FINAL_STEP_RX.test(found.text) && !/check ?out/i.test(found.text)) {
      step(w, p, "begin_checkout", `skipped "${found.text}": looks like a final step`, false);
      return;
    }
    const dest = found.href || found.formAction;
    if (dest) {
      const du = safeUrl(dest);
      if (!du || !isSameSite(du.hostname, w.ctx.siteHost) || isPaymentHost(du.hostname)) {
        step(w, p, "begin_checkout", `checkout leads off-site (${du?.hostname ?? "unknown"}), not followed`, false);
        return;
      }
    }
    const before = page.url();
    try {
      const nav = page
        .waitForURL((u) => !sameDoc(u.href, before), { timeout: w.budget.t(6000), waitUntil: "domcontentloaded" })
        .then(() => true)
        .catch(() => false);
      await page.locator("[data-strativra-checkout]").first().click({ timeout: w.budget.t(2500) });
      const moved = await nav;
      const u = safeUrl(page.url());
      const onSite = !!u && isSameSite(u.hostname, w.ctx.siteHost) && !isPaymentHost(u.hostname);
      if (moved) await visit(w, null);
      const ok = moved && onSite && /(checkouts?|kasse|commande|caisse|order)/i.test(u?.pathname ?? "");
      step(w, p, "begin_checkout", ok ? "clicked checkout and stopped when the checkout page loaded (nothing typed)" : "clicked checkout, no on-site checkout page loaded", ok);
    } catch {
      step(w, p, "begin_checkout", "could not click checkout", false);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export async function walkFunnels(
  page: Page,
  points: ConversionPoint[],
  ctx: WalkContext,
  opts: WalkOptions = {},
): Promise<{ steps: FunnelStep[]; visits: PageVisit[] }> {
  const w: Walker = { page, ctx, budget: new Budget(opts.budgetMs ?? 25000), steps: [], visits: [] };
  const maxPerType = opts.maxPerType ?? 2;
  // Cap per type; contact clicks are capped per channel (phone, email, WhatsApp, chat are separate contracts).
  const perType = new Map<string, number>();
  const queue = points
    .filter((p) => {
      const k = p.type === "contact_click" ? `${p.type}:${metaFor(p).channel ?? ""}` : p.type;
      const n = perType.get(k) ?? 0;
      if (n >= maxPerType) return false;
      perType.set(k, n + 1);
      return true;
    })
    // Non-navigating walks first, grouped by page; purchase last because it leaves the page.
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.pageUrl.localeCompare(b.pageUrl));

  for (const p of queue) {
    if (w.budget.left() < 1500) break;
    const m = metaFor(p);
    try {
      if (p.type === "purchase" && (m.walkable === false || m.purchase === "hosted_checkout")) {
        await walkPurchase(w, p, m);
        continue;
      }
      if (!(await goTo(w, p.pageUrl))) {
        step(w, p, p.type === "purchase" ? "view_item" : "page_view", "could not open the page", false);
        continue;
      }
      if (p.type === "contact_click") await walkContactClick(w, p, m);
      else if (p.type === "download") step(w, p, "download_view", "download link found, not clicked", true);
      else if (p.type === "booking") await walkBooking(w, p, m);
      else if (p.type === "lead" || p.type === "signup") await walkForm(w, p, m);
      else if (p.type === "purchase") await walkPurchase(w, p, m);
    } catch (e) {
      step(w, p, "error", `walk failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`, false);
    }
  }
  return { steps: w.steps, visits: w.visits };
}
