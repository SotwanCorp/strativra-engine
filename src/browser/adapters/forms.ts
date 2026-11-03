/**
 * Lead form tools. Two kinds:
 * - embedded third-party forms (iframe/script/link): HubSpot, Typeform, Jotform, Tally, Google Forms
 *   become their own lead points (cross-origin, so we only view them).
 * - DOM form builders (Webflow, Framer, CF7, Gravity, WPForms, Elementor, HubSpot native) interpret a
 *   form the classifier also sees: the hit carries formSelector and discover.ts merges them.
 */
import type { Adapter } from "./types.ts";
import { toolAdapter, type ToolSpec } from "./embed.ts";
import { safeUrl, hostMatches } from "./hosts.ts";

const form = (s: Omit<ToolSpec, "type" | "noun">): ToolSpec => ({ ...s, type: "lead", noun: "form" });

export const FORM_TOOL_SPECS: ToolSpec[] = [
  form({ id: "hubspot_forms", name: "HubSpot", domains: ["hsforms.com", "hsforms.net"], markers: ["form.hs-form", ".hbspt-form form", "form[id^='hsForm_']", ".hbspt-form"], globals: ["hbspt"], keywords: ["hbspt.forms.create"] }),
  form({ id: "typeform", name: "Typeform", domains: ["typeform.com"], markers: ["[data-tf-widget]", "[data-tf-live]", "[data-tf-popup]", "[data-tf-slider]", "[data-tf-popover]"], links: true }),
  form({ id: "jotform", name: "Jotform", domains: ["jotform.com", "jotfor.ms"], markers: ["iframe[id^='JotFormIFrame']"], links: true }),
  form({ id: "tally", name: "Tally", domains: ["tally.so"], markers: ["[data-tally-src]", "[data-tally-open]"], links: true }),
  form({
    id: "google_forms",
    name: "Google Forms",
    domains: [],
    urlTest: (href) => {
      const u = safeUrl(href);
      if (!u) return false;
      return (hostMatches(u.hostname, "docs.google.com") && u.pathname.startsWith("/forms")) || hostMatches(u.hostname, "forms.gle");
    },
    links: true,
  }),
];

/** DOM form builders: markers point at the <form> (or its wrapper). */
export const DOM_FORM_SPECS: Array<{ id: string; name: string; markers: string[]; platform?: string }> = [
  { id: "webflow_forms", name: "Webflow form", markers: [".w-form form", "form.w-form"], platform: "Webflow" },
  { id: "framer_forms", name: "Framer form", markers: ["form.framer-form", "form[class*='framer-']"], platform: "Framer" },
  { id: "cf7", name: "Contact Form 7", markers: ["form.wpcf7-form", ".wpcf7 form"], platform: "WordPress" },
  { id: "gravity_forms", name: "Gravity Forms", markers: [".gform_wrapper form", "form[id^='gform_']"], platform: "WordPress" },
  { id: "wpforms", name: "WPForms", markers: ["form.wpforms-form", ".wpforms-container form"], platform: "WordPress" },
  { id: "elementor_forms", name: "Elementor form", markers: ["form.elementor-form"], platform: "WordPress" },
];

const domFormAdapters: Adapter[] = DOM_FORM_SPECS.map((spec) => ({
  id: spec.id,
  platform: spec.platform,
  markers: spec.markers,
  isPresent: (s) => spec.markers.some((m) => (s.markers[m]?.count ?? 0) > 0),
  detect: (s) => {
    for (const m of spec.markers) {
      const hit = s.markers[m];
      if (hit && hit.count > 0) {
        return [{
          type: "lead" as const,
          label: spec.name,
          selector: hit.formSelector ?? hit.selector,
          formSelector: hit.formSelector ?? hit.selector,
          confidence: 0.6,
          key: `lead:${spec.id}:${hit.formSelector ?? hit.selector}`,
          meta: { vendor: spec.name, embed: "dom" as const, walkable: true },
        }];
      }
    }
    return [];
  },
}));

export const formAdapters: Adapter[] = [...FORM_TOOL_SPECS.map(toolAdapter), ...domFormAdapters];
