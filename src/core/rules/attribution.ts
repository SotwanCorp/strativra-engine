import type { Evidence } from "../../types.ts";
import type { Rule, RuleContext } from "./types.ts";
import { brandLabel, hostOf, note, registrable, uniq } from "./helpers.ts";

/** Hosts that often take the visitor off-site mid-conversion and come back as a referral. */
export const PAYMENT_BOOKING_HOSTS: ReadonlyArray<{ match: RegExp; name: string; domain: string }> = [
  { match: /(^|\.)stripe\.com$/, name: "Stripe", domain: "stripe.com" },
  { match: /(^|\.)paypal\.com$/, name: "PayPal", domain: "paypal.com" },
  { match: /(^|\.)klarna\.com$/, name: "Klarna", domain: "klarna.com" },
  { match: /(^|\.)mollie\.com$/, name: "Mollie", domain: "mollie.com" },
  { match: /(^|\.)adyen\.com$/, name: "Adyen", domain: "adyen.com" },
  { match: /(^|\.)squareup\.com$/, name: "Square", domain: "squareup.com" },
  { match: /(^|\.)sumup\.com$/, name: "SumUp", domain: "sumup.com" },
  { match: /(^|\.)calendly\.com$/, name: "Calendly", domain: "calendly.com" },
  { match: /(^|\.)acuityscheduling\.com$/, name: "Acuity", domain: "acuityscheduling.com" },
  { match: /(^|\.)cal\.com$/, name: "Cal.com", domain: "cal.com" },
  { match: /^meetings(-[a-z0-9]+)?\.hubspot\.com$/, name: "HubSpot Meetings", domain: "meetings.hubspot.com" },
  { match: /(^|\.)simplybook\.(me|it)$/, name: "SimplyBook", domain: "simplybook.me" },
];

function paymentName(host: string): string | undefined {
  // Stripe Elements frames stay on the page; no redirect, no referral.
  if (host === "js.stripe.com" || host === "m.stripe.network") return undefined;
  return PAYMENT_BOOKING_HOSTS.find((p) => p.match.test(host))?.name;
}

const NAV_TYPES = ["document", "sub_frame", "iframe"];

/** URLs on the conversion path: walked steps, conversion point pages, visited pages, navigations and frames. */
function pathUrls(ctx: RuleContext): Array<{ url: string; ref?: string; why: string }> {
  const out: Array<{ url: string; ref?: string; why: string }> = [];
  for (const p of ctx.capture.conversionPoints) {
    out.push({ url: p.pageUrl, why: `conversion point ${p.label}` });
    for (const s of p.walk) out.push({ url: s.pageUrl, why: `funnel step ${s.name}` });
  }
  for (const p of ctx.capture.pages) out.push({ url: p.url, why: `page visit (${p.via})` });
  for (const s of ctx.capture.scenarios) {
    for (const r of s.requests) if (NAV_TYPES.includes(r.resourceType)) out.push({ url: r.url, ref: r.id, why: r.resourceType });
  }
  return out;
}

const hasGa4 = (ctx: RuleContext) => ctx.hits.some((h) => h.vendor === "ga4");

const referralExclusion: Rule = {
  id: "attribution.payment_referral_exclusion",
  appliesTo: hasGa4,
  run(ctx) {
    const found = new Map<string, Evidence>();
    for (const u of pathUrls(ctx)) {
      const name = paymentName(hostOf(u.url));
      if (!name || found.has(name)) continue;
      found.set(name, { kind: u.ref ? "hit" : "note", caption: `${name} on the conversion path (${u.why})`, ref: u.ref, data: { host: hostOf(u.url) } });
    }
    for (const p of ctx.capture.conversionPoints) {
      const name = PAYMENT_BOOKING_HOSTS.find((h) => h.name.toLowerCase() === p.detectedBy.toLowerCase())?.name;
      if (name && !found.has(name)) found.set(name, note(`${name} detected by adapter`, { point: p.id }));
    }
    if (found.size === 0) return [];
    const names = [...found.keys()];
    return [
      {
        id: this.id,
        title: `Check that ${names.join(", ")} cannot steal your conversions`,
        severity: "medium",
        why: `Visitors go through ${names.join(", ")} to convert. If that domain is not in your unwanted referrals list, GA4 credits the conversion to it instead of your ads.`,
        conversionTypes: uniq(ctx.capture.conversionPoints.map((p) => p.type)),
        vendors: ["ga4"],
        impact: 3,
        confidence: 1,
        reach: 2,
        effort: 1,
        reproduced: false,
        evidence: [...found.values()].slice(0, 5),
        fix: {
          summary: "Check your unwanted referrals list in GA4.",
          steps: [
            "In GA4, open Admin, Data streams, your web stream, Configure tag settings, List unwanted referrals.",
            `Add ${names.map((n) => PAYMENT_BOOKING_HOSTS.find((h) => h.name === n)?.domain ?? n).join(", ")} if missing.`,
            "In the paid audit we confirm this in your GA4 settings.",
          ],
        },
      },
    ];
  },
};

const crossDomainNoGl: Rule = {
  id: "attribution.cross_domain_no_gl",
  appliesTo: hasGa4,
  run(ctx) {
    const site = ctx.siteHost.toLowerCase();
    const siteReg = registrable(site);
    const brand = brandLabel(site);
    if (brand.length < 4) return [];
    const hits = new Map<string, { url: string; ref?: string }>();
    for (const u of pathUrls(ctx)) {
      const host = hostOf(u.url);
      if (!host || registrable(host) === siteReg || paymentName(host)) continue;
      if (brandLabel(host) !== brand && !brandLabel(host).includes(brand)) continue;
      let hasGl = false;
      try {
        hasGl = new URL(u.url).searchParams.has("_gl");
      } catch {
        continue;
      }
      if (hasGl) continue;
      const reg = registrable(host);
      if (!hits.has(reg)) hits.set(reg, { url: u.url, ref: u.ref });
    }
    if (hits.size === 0) return [];
    const domains = [...hits.keys()];
    return [
      {
        id: this.id,
        title: "Visitors lose their session when moving to your other domain",
        severity: "medium",
        why: `Links to ${domains.join(", ")} carry no _gl parameter. GA4 starts a new session there, so conversions lose their original source.`,
        conversionTypes: uniq(ctx.capture.conversionPoints.map((p) => p.type)),
        vendors: ["ga4"],
        impact: 3,
        confidence: 2,
        reach: 2,
        effort: 1,
        reproduced: true,
        evidence: [...hits.values()].slice(0, 4).map((h) => ({ kind: h.ref ? ("hit" as const) : ("note" as const), caption: "Navigation without _gl", ref: h.ref, data: { url: h.url.slice(0, 200) } })),
        fix: {
          summary: "Set up cross-domain measurement in GA4 for both domains.",
          steps: [
            "In GA4, open the web stream, Configure tag settings, Configure your domains, and add both domains.",
            "Make sure the same GA4 tag runs on both sites.",
            "Click a link between them and check the URL carries _gl.",
          ],
        },
      },
    ];
  },
};

export const ATTRIBUTION_RULES: Rule[] = [referralExclusion, crossDomainNoGl];
