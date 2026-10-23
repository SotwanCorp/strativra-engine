/**
 * Consent banner handling.
 *
 * Primary: DuckDuckGo autoconsent (MPL-2.0, used unmodified). Its bundled
 * `dist/autoconsent.playwright.js` is injected into every frame as an init
 * script and talks to Node through two globals (see the package's
 * docs/puppeteer.md and playwright/runner.ts):
 *   page -> node: window.autoconsentSendMessage(msg)   (context.exposeBinding)
 *   node -> page: window.autoconsentReceiveMessage(msg) (frame.evaluate)
 * We answer `init` with `initResp` (config + the full rules.json, filtered
 * per frame by runContext/urlPattern), run `eval` requests in the frame's
 * main world, and record cmpDetected / popupFound. `autoAction` is null, so
 * nothing is clicked until handleBanner() sends `optIn` (accept) or
 * `optOut` (reject) to the frame that found the popup.
 *
 * Fallback: conservative multilingual text match on visible buttons in the
 * main frame and CMP-looking iframes. Never clicks inside a <form> that has
 * other inputs, nor anything labelled submit/pay/buy/order/subscribe/send.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { BrowserContext, Frame, Page } from "playwright-core";
import type { BannerOutcome } from "../types.ts";

export type BannerAction = "accept" | "reject";

export interface BannerResult {
  outcome: BannerOutcome;
  cmp?: string;
  method?: "autoconsent" | "fallback";
}

type Msg = { type: string; [k: string]: unknown };
type Rule = { name: string; runContext?: { main?: boolean; frame?: boolean; urlPattern?: string } };

interface PageState {
  cmp?: string;
  popupFrame?: Frame;
  popupCmp?: string;
  results: Msg[];
  done: boolean;
  errors: string[];
}

const require = createRequire(import.meta.url);
let cached: { script: string; rules: Rule[] } | null = null;

function loadAutoconsent(): { script: string; rules: Rule[] } {
  if (cached) return cached;
  // "." resolves to dist/autoconsent.cjs.js; the Playwright bundle sits next to it.
  const distDir = path.dirname(require.resolve("@duckduckgo/autoconsent"));
  const script = readFileSync(path.join(distDir, "autoconsent.playwright.js"), "utf8");
  const rulesPath = require.resolve("@duckduckgo/autoconsent/rules/rules.json");
  const rules = (JSON.parse(readFileSync(rulesPath, "utf8")) as { autoconsent: Rule[] }).autoconsent;
  cached = { script, rules };
  return cached;
}

function rulesFor(url: string, mainFrame: boolean): Rule[] {
  const { rules } = loadAutoconsent();
  return rules.filter((r) => {
    const rc = r.runContext ?? {};
    const main = rc.main ?? true;
    const frame = rc.frame ?? false;
    if (mainFrame ? !main : !frame) return false;
    if (rc.urlPattern) {
      try {
        return new RegExp(rc.urlPattern).test(url);
      } catch {
        return false;
      }
    }
    return true;
  });
}

const states = new WeakMap<Page, PageState>();

function stateOf(page: Page): PageState {
  let s = states.get(page);
  if (!s) {
    s = { results: [], done: false, errors: [] };
    states.set(page, s);
  }
  return s;
}

function sendTo(frame: Frame, msg: object): Promise<unknown> {
  return frame
    .evaluate((m) => {
      const w = window as unknown as { autoconsentReceiveMessage?: (m: unknown) => unknown };
      return w.autoconsentReceiveMessage ? w.autoconsentReceiveMessage(m) : undefined;
    }, msg)
    .catch(() => undefined);
}

/**
 * Install the autoconsent bridge on a context. Call before opening pages.
 * `action` only tunes heuristics (reject heuristics for "reject").
 */
export async function installAutoconsent(context: BrowserContext, action: BannerAction): Promise<void> {
  const { script } = loadAutoconsent();
  await context.exposeBinding("autoconsentSendMessage", async (source: { frame: Frame; page: Page }, raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as Msg;
    const { frame, page } = source;
    const st = stateOf(page);
    const isMain = frame === page.mainFrame();
    switch (msg.type) {
      case "init":
        await sendTo(frame, {
          type: "initResp",
          config: {
            enabled: true,
            autoAction: null,
            disabledCmps: [],
            enablePrehide: false,
            enableCosmeticRules: true,
            enableGeneratedRules: true,
            detectRetries: 20,
            isMainWorld: false,
            prehideTimeout: 2000,
            enableHeuristicDetection: false,
            enablePopupMutationObserver: true,
            heuristicMode: action === "reject" ? "reject" : "off",
            visualTest: false,
            logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
          },
          rules: { autoconsent: rulesFor(String(msg.url ?? frame.url()), isMain) },
        });
        break;
      case "eval": {
        let result: unknown = false;
        try {
          result = await frame.evaluate(String(msg.code));
        } catch {
          /* frame navigated or detached */
        }
        await sendTo(frame, { type: "evalResp", id: msg.id, result });
        break;
      }
      case "cmpDetected":
        st.cmp = st.cmp ?? String(msg.cmp);
        break;
      case "popupFound":
        st.popupFrame = frame;
        st.popupCmp = String(msg.cmp);
        break;
      case "optInResult":
      case "optOutResult":
        st.results.push(msg);
        break;
      case "autoconsentDone":
        st.done = true;
        break;
      case "autoconsentError":
        st.errors.push(JSON.stringify(msg.details ?? null).slice(0, 300));
        break;
    }
  });
  await context.addInitScript({ content: script });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms: number, step = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

/* ------------------------------------------------------------------ */
/* Fallback                                                            */
/* ------------------------------------------------------------------ */

/** Multilingual labels (lowercase, matched as whole label or leading phrase). */
export const ACCEPT_LABELS = [
  // en
  "accept all", "accept all cookies", "accept cookies", "accept", "allow all", "allow all cookies", "allow cookies", "allow", "i agree", "agree", "agree and close", "ok", "got it", "i accept", "yes, i agree",
  // fr
  "tout accepter", "accepter", "accepter tout", "accepter et fermer", "j'accepte", "autoriser tous les cookies", "tout autoriser", "d'accord",
  // de
  "alle akzeptieren", "akzeptieren", "alle cookies akzeptieren", "zustimmen", "alle zulassen", "einverstanden", "ich stimme zu",
  // es
  "aceptar todo", "aceptar todas", "aceptar", "aceptar cookies", "permitir todas", "de acuerdo",
  // it
  "accetta tutto", "accetta", "accetta tutti", "accetto", "consenti tutti",
  // nl
  "alles accepteren", "accepteren", "akkoord", "alle cookies toestaan", "alles toestaan",
  // ar
  "قبول الكل", "قبول", "أوافق", "موافق", "السماح بالكل",
];

export const REJECT_LABELS = [
  // en
  "reject all", "reject all cookies", "reject", "decline all", "decline", "deny all", "deny", "refuse all", "only necessary", "only essential", "necessary only", "essential only", "use necessary cookies only", "accept only essential cookies", "continue without accepting",
  // fr
  "tout refuser", "refuser", "refuser tout", "continuer sans accepter", "uniquement nécessaires",
  // de
  "alle ablehnen", "ablehnen", "nur notwendige", "nur essenzielle", "nur erforderliche cookies",
  // es
  "rechazar todo", "rechazar todas", "rechazar", "solo necesarias",
  // it
  "rifiuta tutto", "rifiuta", "rifiuta tutti", "solo necessari", "continua senza accettare",
  // nl
  "alles weigeren", "weigeren", "alleen noodzakelijke", "afwijzen",
  // ar
  "رفض الكل", "رفض", "رفض جميع",
];

/** Labels that must never be clicked, whatever else matches. */
export const DANGER_LABEL = /submit|pay|buy|order|purchase|checkout|subscribe|send|sign ?up|register|log ?in|confirm|book|envoyer|payer|commander|acheter|s'inscrire|absenden|kaufen|bestellen|zahlen|enviar|pagar|comprar|invia|paga|acquista|verzenden|bestellen|betalen|kopen|إرسال|شراء|ادفع/i;

/** Selectors that look like a consent banner container (for "not_clickable"). */
const BANNER_HINT =
  '[id*="cookie" i],[id*="privacy" i],[class*="privacy" i],[class*="cc-window"],[class*="cc-banner"],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i],[aria-label*="cookie" i],[aria-label*="consent" i],[role="dialog"][aria-modal="true"]';
const CMP_IFRAME = /consent|cookie|cmp|privacy|gdpr|sourcepoint|trustarc|didomi|onetrust|usercentrics|quantcast|cookiebot/i;

interface FallbackScan {
  bannerVisible: boolean;
  clicked: boolean;
  label?: string;
}

/** Runs inside the frame. Pure DOM; returns what it did. */
function fallbackInFrame(arg: { labels: string[]; danger: string; hint: string; click: boolean; wholeFrame: boolean }): FallbackScan {
  const danger = new RegExp(arg.danger, "i");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!…]+$/, "");
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el as HTMLElement);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const roots: Array<Document | ShadowRoot> = [document];
  // Open shadow roots (some CMPs render there).
  for (const el of Array.from(document.querySelectorAll("*"))) if (el.shadowRoot) roots.push(el.shadowRoot);
  const hints: Element[] = [];
  for (const r of roots) hints.push(...Array.from(r.querySelectorAll(arg.hint)).filter(visible));
  // A banner = a visible hint container that overlays the page (fixed/sticky
  // or a modal dialog) and talks about cookies / consent.
  const overlays = (el: Element) => {
    let cur: Element | null = el;
    for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
      const pos = getComputedStyle(cur).position;
      if (pos === "fixed" || pos === "sticky" || cur.getAttribute("role") === "dialog" || cur.tagName === "DIALOG") return true;
    }
    return false;
  };
  const consentText = /cookie|consent|privacy|datenschutz|confidentialit|privacidad|riservatezza|toestemming|ملفات تعريف|الخصوصية/i;
  const bannerVisible = arg.wholeFrame || hints.some((h) => overlays(h) && consentText.test((h as HTMLElement).innerText || ""));
  const candidates: HTMLElement[] = [];
  for (const r of roots)
    candidates.push(
      ...(Array.from(r.querySelectorAll('button, [role="button"], a[href="#"], a:not([href]), input[type="button"]')) as HTMLElement[]),
    );
  for (const label of arg.labels) {
    for (const el of candidates) {
      const text = norm(el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "");
      if (!text || text.length > 60) continue;
      if (text !== label) continue;
      if (danger.test(text)) continue;
      if (!visible(el)) continue;
      // Only inside a banner-looking container (or anywhere in a CMP iframe).
      const rootNode = el.getRootNode();
      const host = rootNode instanceof ShadowRoot ? rootNode.host : null;
      const inBanner = arg.wholeFrame || !!el.closest(arg.hint) || !!(host && (host.matches(arg.hint) || host.closest(arg.hint)));
      if (!inBanner) continue;
      const form = el.closest("form");
      if (form && form.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select').length > 0)
        continue;
      if (arg.click) {
        // Prevent any form submission side effect of the button itself.
        if (form) form.addEventListener("submit", (e) => e.preventDefault(), { capture: true });
        document.querySelectorAll("[data-strv-target]").forEach((x) => x.removeAttribute("data-strv-target"));
        el.setAttribute("data-strv-target", "1");
      }
      return { bannerVisible: true, clicked: arg.click, label: text };
    }
  }
  return { bannerVisible, clicked: false };
}

function fallbackFrames(page: Page): Frame[] {
  const main = page.mainFrame();
  const out = [main];
  for (const f of page.frames()) if (f !== main && CMP_IFRAME.test(f.url())) out.push(f);
  return out;
}

async function bannerStillVisible(page: Page): Promise<boolean> {
  const main = page.mainFrame();
  for (const f of fallbackFrames(page)) {
    const r = await f
      .evaluate(fallbackInFrame, {
        labels: [...ACCEPT_LABELS, ...REJECT_LABELS],
        danger: DANGER_LABEL.source,
        hint: BANNER_HINT,
        click: false,
        wholeFrame: f !== main,
      })
      .catch(() => null);
    if (r && r.label) return true; // a consent button is still visible
  }
  return false;
}

async function runFallback(page: Page, action: BannerAction, beforeClick?: () => void): Promise<BannerResult> {
  const labels = action === "accept" ? ACCEPT_LABELS : REJECT_LABELS;
  let sawBanner = false;
  const main = page.mainFrame();
  for (const f of fallbackFrames(page)) {
    const r = await f
      .evaluate(fallbackInFrame, { labels, danger: DANGER_LABEL.source, hint: BANNER_HINT, click: true, wholeFrame: f !== main })
      .catch(() => null);
    if (!r) continue;
    if (r.bannerVisible) sawBanner = true;
    if (r.clicked) {
      beforeClick?.();
      // Real (trusted) click via Playwright; the target was marked in-frame.
      const target = f.locator("[data-strv-target]").first();
      try {
        await target.click({ timeout: 3000 });
      } catch {
        await target.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
      }
      await sleep(1200);
      const still = await bannerStillVisible(page);
      return still ? { outcome: "not_clickable", cmp: "fallback", method: "fallback" } : { outcome: "clicked", cmp: "fallback", method: "fallback" };
    }
  }
  if (!sawBanner) {
    // A banner with only the *other* button visible still counts as a banner.
    sawBanner = await bannerStillVisible(page);
  }
  return sawBanner ? { outcome: "not_clickable", cmp: "fallback", method: "fallback" } : { outcome: "no_banner" };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Accept or reject the consent banner on the current page.
 * Requires installAutoconsent() on the page's context for the primary path;
 * without it only the fallback runs.
 */
export async function handleBanner(
  page: Page,
  action: BannerAction,
  opts: { detectMs?: number; actionMs?: number; /** Called right before the first click (the runner flips phase to "post"). */ beforeAction?: () => void } = {},
): Promise<BannerResult> {
  const st = stateOf(page);
  const detectMs = opts.detectMs ?? 4000;
  const actionMs = opts.actionMs ?? 8000;
  await waitFor(() => !!st.popupFrame, detectMs);
  if (st.popupFrame) {
    const cmp = st.popupCmp ?? st.cmp;
    const before = st.results.length;
    opts.beforeAction?.();
    await sendTo(st.popupFrame, { type: action === "accept" ? "optIn" : "optOut" });
    const want = action === "accept" ? "optInResult" : "optOutResult";
    await waitFor(() => st.results.slice(before).some((m) => m.type === want), actionMs);
    const res = st.results.slice(before).find((m) => m.type === want);
    if (res && res.result === true) {
      await waitFor(() => st.done, 2000);
      return { outcome: "clicked", cmp, method: "autoconsent" };
    }
    // autoconsent found the popup but could not act: try the fallback.
    const fb = await runFallback(page, action, opts.beforeAction);
    if (fb.outcome === "clicked") return { ...fb, cmp: cmp ?? fb.cmp };
    return { outcome: "not_clickable", cmp, method: "autoconsent" };
  }
  const fb = await runFallback(page, action, opts.beforeAction);
  if (fb.outcome === "no_banner" && st.cmp) {
    // CMP present (e.g. already decided or hidden) but no visible popup.
    return { outcome: "no_banner", cmp: st.cmp, method: "autoconsent" };
  }
  return fb;
}
