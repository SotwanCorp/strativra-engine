/**
 * Scored form classifier (SPEC section 8: "forms classified by scored signals").
 *
 * Two halves:
 * - extractFormsInPage(): runs in the page (page.evaluate / frame.evaluate). It reads every
 *   <form> and every form-like container (an element outside a <form> holding >= 2 user fields
 *   and a button) and returns plain FormFeatures. Read-only: it never touches field values.
 * - scoreForm(): pure scoring over FormFeatures, unit-tested without a browser.
 *
 * Only contact/lead, signup and newsletter (as a low-confidence lead) become ConversionPoints.
 */
import type { Frame, Page } from "playwright-core";
import type { ConversionType } from "../types.ts";
import { isSameSite, safeUrl } from "./adapters/hosts.ts";

export type FormKind = "login" | "search" | "newsletter" | "contact" | "signup" | "checkout" | "unknown";
type ScoredKind = Exclude<FormKind, "unknown">;

export interface FormFeatures {
  /** cssPath of the form/container inside its frame. */
  selector: string;
  isFormElement: boolean;
  action: string;
  method: string;
  /** User-fillable fields (no hidden/submit/button, no honeypots). */
  fields: number;
  /** Plain text-like inputs (text, untyped, number, date, url...) incl. name fields. */
  textInputs: number;
  /** Text inputs that look like a person's name. */
  nameInputs: number;
  emailInputs: number;
  telInputs: number;
  passwordInputs: number;
  searchInputs: number;
  textareas: number;
  selects: number;
  checkboxes: number;
  fileInputs: number;
  /** Lowercased autocomplete tokens of all fields. */
  autocomplete: string[];
  /** Lowercased name attributes. */
  names: string[];
  /** Per field: "name id placeholder aria-label label", lowercased. */
  descriptors: string[];
  roleSearch: boolean;
  inFooter: boolean;
  /** Lowercased wording: visible text, button labels, aria-label, nearby heading, action, id/classes. */
  text: string;
  /** id + classes of the root and a few ancestors (lowercased). */
  classes: string;
  buttons: string[];
}

export interface FormScore {
  kind: FormKind;
  confidence: number;
  scores: Record<ScoredKind, number>;
}

export interface ClassifiedForm extends FormFeatures, FormScore {
  /** Set when the form lives in a same-site child frame. */
  frameUrl?: string;
}

const RX: Record<ScoredKind, RegExp> = {
  login: /\b(log ?in|sign ?in|connexion|se connecter|anmelden|einloggen|iniciar sesi[oó]n|forgot (your )?password|mot de passe oubli)/,
  signup: /\b(sign ?up|register|registration|create (an |your |my )?account|get started|start (your |a )?(free )?trial|join (now|free)|inscription|s'inscrire|cr[ée]er (un |mon |votre )?compte|registrieren|konto erstellen)/,
  search: /\b(search|rechercher|recherche|suche|suchen|buscar)\b/,
  newsletter: /\b(newsletter|subscribe|subscription|s'abonner|abonnez|abonnieren|mailing list|stay (up to date|in the loop)|inscrivez-vous|weekly digest)\b/,
  contact: /\b(contact|quote|devis|demo|enquiry|inquiry|message|get in touch|kontakt|anfrage|request a call|call ?back|nous contacter|send|envoyer|senden|project|projet)\b/,
  checkout: /\b(checkout|check out|payment|card number|place order|billing|shipping address|paiement|zahlung|kasse)\b/,
};

const clampRound = (x: number) => Math.round(Math.max(0, Math.min(0.97, x)) * 100) / 100;

/** Pure scoring. Higher score = stronger evidence. Kind is "unknown" below 3 points. */
export function scoreForm(f: FormFeatures): FormScore {
  const t = f.text.toLowerCase();
  const ac = f.autocomplete.join(" ").toLowerCase();
  const desc = f.descriptors.join(" ").toLowerCase();
  const has = (k: ScoredKind) => RX[k].test(t);
  const pw = f.passwordInputs;
  const newPw = /\bnew-password\b/.test(ac);
  const curPw = /\bcurrent-password\b/.test(ac);
  const s: Record<ScoredKind, number> = { login: 0, signup: 0, search: 0, newsletter: 0, contact: 0, checkout: 0 };

  // login
  if (pw > 0) {
    s.login += 3;
    if (curPw) s.login += 4;
    if (/\busername\b/.test(ac)) s.login += 1;
    if (has("login")) s.login += 2;
    if (pw === 1 && f.fields <= 3) s.login += 1;
    if (newPw) s.login -= 4;
    if (pw >= 2) s.login -= 2;
    if (has("signup")) s.login -= 2;
  }

  // signup
  if (newPw) s.signup += 4;
  if (pw > 0 && f.emailInputs > 0) s.signup += 1;
  if (pw >= 2) s.signup += 2;
  if (has("signup")) s.signup += 3;
  if (pw === 0) s.signup = has("signup") && f.emailInputs > 0 ? Math.min(s.signup, 3) : 0; // passwordless sign-up needs explicit wording
  if (curPw) s.signup -= 3;
  if (f.textareas) s.signup -= 3;

  // search
  if (f.roleSearch) s.search += 4;
  if (f.searchInputs > 0) s.search += 4;
  if (f.fields <= 2 && f.names.some((n) => /^(q|s|search|query|keywords?|term|k|search_query)$/.test(n))) s.search += 3;
  if (has("search")) s.search += 1;
  if (f.fields > 2) s.search -= 2;
  if (f.textareas) s.search -= 4;
  if (f.emailInputs) s.search -= 3;
  if (pw) s.search -= 4;

  // newsletter
  if (f.emailInputs === 1 && f.fields <= 3 && f.textareas === 0 && pw === 0) {
    s.newsletter += 3;
    if (f.fields === 1) s.newsletter += 1;
  }
  if (has("newsletter")) s.newsletter += 3;
  if (f.inFooter) s.newsletter += 1;
  if (f.textareas) s.newsletter -= 4;
  if (pw) s.newsletter -= 5;
  if (f.telInputs) s.newsletter -= 1;
  if (f.fields > 3) s.newsletter -= 2;
  if (f.emailInputs === 0) s.newsletter = Math.min(s.newsletter, 0);

  // contact / lead
  if (f.textareas) s.contact += 3;
  if (f.nameInputs && (f.emailInputs || f.telInputs)) s.contact += 2;
  if (f.telInputs) s.contact += 1;
  if (has("contact")) s.contact += 3;
  if (f.fields >= 3) s.contact += 1;
  if (pw) s.contact -= 5;
  if (f.emailInputs + f.telInputs + f.textareas + f.nameInputs === 0) s.contact = Math.min(s.contact, 1);

  // checkout
  if (/\bcc-(number|exp|csc|name)/.test(ac) || /card.?number|cardnumber|\bcvc\b|\bcvv\b/.test(desc)) s.checkout += 5;
  if (/\baddress-line1\b|\bpostal-code\b/.test(ac)) s.checkout += 2;
  if (/\b(shipping|billing)\b/.test(ac)) s.checkout += 3;
  if (has("checkout")) s.checkout += 2;
  if (s.checkout >= 5) {
    s.contact -= 3;
    s.newsletter -= 3;
    s.signup -= 2;
  }

  const ranked = (Object.entries(s) as Array<[ScoredKind, number]>).sort((a, b) => b[1] - a[1]);
  const [bestKind, best] = ranked[0]!;
  const second = Math.max(0, ranked[1]![1]);
  if (best < 3) return { kind: "unknown", confidence: 0, scores: s };
  return { kind: bestKind, confidence: clampRound(best / (best + second + 2)), scores: s };
}

/** Which form kinds become conversion points, and with what confidence. */
export function formToConversion(kind: FormKind, confidence: number): { type: ConversionType; confidence: number } | null {
  if (kind === "contact") return { type: "lead", confidence };
  if (kind === "signup") return { type: "signup", confidence };
  if (kind === "newsletter") return { type: "lead", confidence: clampRound(confidence * 0.4) };
  return null;
}

/* ------------------------------------------------------------------ */
/* In-page extraction. Self-contained: no closures over module scope.   */
/* ------------------------------------------------------------------ */

export function extractFormsInPage(): FormFeatures[] {
  // Keep in sync with cssPath in discover.ts (same algorithm, so selectors match).
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
  const FIELD = "input, textarea, select";
  const BUTTON = "button, input[type=submit], input[type=button], input[type=image], [role=button]";
  const clean = (s: string | null | undefined, max = 200) => (s || "").replace(/\s+/g, " ").trim().slice(0, max);
  const isUserField = (el: Element): boolean => {
    if (el instanceof HTMLInputElement) {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(t)) return false;
    } else if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLSelectElement)) return false;
    // honeypots
    const n = ((el.getAttribute("name") || "") + " " + (el.id || "")).toLowerCase();
    if (/honeypot|_gotcha|\bhp\b|ak_hp|wpcf7-hp/.test(n)) return false;
    if (el.getAttribute("tabindex") === "-1" && el.closest("[aria-hidden=true]")) return false;
    return true;
  };
  const labelOf = (el: Element): string => {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clean(labels[0]!.textContent, 80);
    const l = el.closest("label");
    return l ? clean(l.textContent, 80) : "";
  };

  const roots: Element[] = Array.from(document.forms);
  const cands = new Set<Element>();
  for (const f of Array.from(document.querySelectorAll(FIELD))) {
    if (!isUserField(f) || f.closest("form")) continue;
    let cur = f.parentElement;
    for (let depth = 0; cur && cur !== document.body && depth < 8; depth++) {
      const n = Array.from(cur.querySelectorAll(FIELD)).filter(isUserField).length;
      if (n >= 2 && cur.querySelector(BUTTON)) {
        cands.add(cur);
        break;
      }
      cur = cur.parentElement;
    }
  }
  const list = [...cands];
  for (const c of list) if (!list.some((o) => o !== c && c.contains(o))) roots.push(c);

  const out: FormFeatures[] = [];
  for (const root of roots.slice(0, 60)) {
    const fields = Array.from(root.querySelectorAll(FIELD)).filter(isUserField);
    const f: FormFeatures = {
      selector: cssPath(root),
      isFormElement: root instanceof HTMLFormElement,
      action: root instanceof HTMLFormElement ? root.getAttribute("action") || "" : "",
      method: root instanceof HTMLFormElement ? (root.getAttribute("method") || "get").toLowerCase() : "",
      fields: 0, textInputs: 0, nameInputs: 0, emailInputs: 0, telInputs: 0, passwordInputs: 0,
      searchInputs: 0, textareas: 0, selects: 0, checkboxes: 0, fileInputs: 0,
      autocomplete: [], names: [], descriptors: [],
      roleSearch: !!(root.getAttribute("role") === "search" || root.closest("[role=search], search")),
      inFooter: !!root.closest("footer, [role=contentinfo], #footer, .footer, .site-footer"),
      text: "",
      classes: "",
      buttons: [],
    };
    for (const el of fields) {
      const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
      const name = (el.getAttribute("name") || "").toLowerCase();
      const d = [name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), labelOf(el)]
        .map((x) => clean(x, 80)).join(" ").toLowerCase();
      if (ac) f.autocomplete.push(ac);
      if (name) f.names.push(name);
      f.descriptors.push(d);
      f.fields++;
      if (el instanceof HTMLTextAreaElement) { f.textareas++; continue; }
      if (el instanceof HTMLSelectElement) { f.selects++; continue; }
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "password") f.passwordInputs++;
      else if (t === "email" || /\bemail\b/.test(ac) || (t === "text" && /e-?mail|courriel/.test(d))) f.emailInputs++;
      else if (t === "tel" || /\btel\b/.test(ac) || /phone|\btel\b|mobile|t[ée]l[ée]phone|portable|handy|whatsapp/.test(d)) f.telInputs++;
      else if (t === "search") f.searchInputs++;
      else if (t === "checkbox" || t === "radio") f.checkboxes++;
      else if (t === "file") f.fileInputs++;
      else {
        f.textInputs++;
        if (/\b(given-name|family-name|name)\b/.test(ac) || /name|\bnom\b|pr[ée]nom|vorname|nachname|first|last/.test(d)) f.nameInputs++;
      }
    }
    f.buttons = Array.from(root.querySelectorAll(BUTTON))
      .map((b) => clean((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("aria-label"), 60))
      .filter(Boolean)
      .slice(0, 6);
    const section = root.closest("section, article, aside, footer, header, [class*=modal], [role=dialog]") || root.parentElement;
    const heading = section ? section.querySelector("h1, h2, h3, h4, legend") : null;
    f.text = [
      clean((root as HTMLElement).innerText, 600),
      f.buttons.join(" "),
      root.getAttribute("aria-label"),
      root.getAttribute("name"),
      heading ? clean(heading.textContent, 120) : "",
      f.action,
      root.id,
      typeof root.className === "string" ? root.className : "",
    ].join(" ").toLowerCase();
    const cls: string[] = [];
    let a: Element | null = root;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) cls.push(a.id, typeof a.className === "string" ? a.className : "");
    f.classes = cls.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
    out.push(f);
  }
  return out;
}

async function classifyFrame(frame: Frame, frameUrl?: string): Promise<ClassifiedForm[]> {
  try {
    const raw = await frame.evaluate(extractFormsInPage);
    return raw.map((f) => {
      const c: ClassifiedForm = { ...f, ...scoreForm(f) };
      if (frameUrl) c.frameUrl = frameUrl;
      return c;
    });
  } catch {
    return [];
  }
}

/**
 * Classify every form in the main frame and in same-site child frames.
 * Cross-site iframes (Typeform, HubSpot...) are left to the adapters.
 */
export async function classifyForms(page: Page, siteHost?: string): Promise<ClassifiedForm[]> {
  const main = page.mainFrame();
  const host = siteHost ?? safeUrl(page.url())?.hostname ?? "";
  const out = await classifyFrame(main);
  for (const fr of page.frames()) {
    if (fr === main || fr.isDetached()) continue;
    const u = safeUrl(fr.url());
    if (!u || !/^https?:$/.test(u.protocol) || !isSameSite(u.hostname, host)) continue;
    out.push(...(await classifyFrame(fr, fr.url())));
  }
  return out;
}
