import type { ScenarioRun } from "../../types.ts";
import type { Rule, RuleContext } from "./types.ts";
import {
  AD_VENDORS,
  GOOGLE_VENDORS,
  current,
  effectivelyGranted,
  hasConsentSignals,
  hitEvidence,
  isTracking,
  normUrl,
  note,
  reachFrom,
  sampleHits,
  uniq,
  vendorsOf,
} from "./helpers.ts";

function scenario(ctx: RuleContext, s: ScenarioRun["scenario"]): ScenarioRun | undefined {
  return ctx.capture.scenarios.find((r) => r.scenario === s);
}

/** A banner was seen in at least one scenario. */
function bannerSeen(ctx: RuleContext): boolean {
  return ctx.capture.scenarios.some((r) => r.banner === "clicked" || r.banner === "not_clickable" || !!r.cmp);
}

function noBannerAnywhere(ctx: RuleContext): boolean {
  const withChoice = ctx.capture.scenarios.filter((r) => r.scenario !== "none");
  if (withChoice.length === 0) return false;
  return withChoice.every((r) => r.banner === "no_banner") && !ctx.capture.scenarios.some((r) => r.cmp);
}

function pagesVisited(ctx: RuleContext): number {
  return Math.max(1, uniq(ctx.capture.pages.map((p) => normUrl(p.url))).length);
}

const firesBeforeConsent: Rule = {
  id: "consent.fires_before_consent",
  appliesTo: (ctx) => bannerSeen(ctx),
  run(ctx) {
    const bad = ctx.hits.filter(
      (h) => isTracking(h) && h.phase === "pre" && (h.scenario === "none" || h.scenario === "reject") && effectivelyGranted(h),
    );
    if (bad.length === 0) return [];
    const pages = uniq(bad.map((h) => normUrl(h.pageUrl))).length;
    return [
      {
        id: this.id,
        title: "Tags fire before the visitor makes a consent choice",
        severity: "critical",
        why: "Marketing or analytics tags send data before anyone clicks the banner. In the EU that is a compliance risk and it makes your consent rates look wrong.",
        conversionTypes: [],
        vendors: vendorsOf(bad),
        impact: 5,
        confidence: 3,
        reach: reachFrom(pages, pagesVisited(ctx)),
        effort: 2,
        reproduced: true,
        evidence: sampleHits(bad).map((h) => hitEvidence(h, `${h.vendor} ${h.eventName} sent before any consent choice`)),
        fix: {
          summary: "Hold every marketing and analytics tag until consent is granted, or run Google tags in Consent Mode with denied defaults.",
          steps: [
            "Set a Consent Mode default of denied for all four keys before any Google tag loads.",
            "In GTM, add consent checks or consent triggers to non-Google tags (Meta, LinkedIn, TikTok, Microsoft).",
            "Fire those tags only on the consent update event from your banner.",
            "Re-test with the banner untouched and confirm no tracking hits leave the page.",
          ],
        },
      },
    ];
  },
};

const grantedAfterReject: Rule = {
  id: "consent.granted_after_reject",
  appliesTo: (ctx) => scenario(ctx, "reject")?.banner === "clicked",
  run(ctx) {
    const bad = ctx.hits.filter((h) => isTracking(h) && h.scenario === "reject" && h.phase === "post" && effectivelyGranted(h));
    if (bad.length === 0) return [];
    const pages = uniq(bad.map((h) => normUrl(h.pageUrl))).length;
    return [
      {
        id: this.id,
        title: "Tracking keeps running after the visitor rejects",
        severity: "critical",
        why: "After we clicked reject, tags still sent data as if consent was granted. The banner choice is not respected.",
        conversionTypes: [],
        vendors: vendorsOf(bad),
        impact: 5,
        confidence: 3,
        reach: reachFrom(pages, pagesVisited(ctx)),
        effort: 2,
        reproduced: true,
        evidence: sampleHits(bad).map((h) => hitEvidence(h, `${h.vendor} ${h.eventName} after reject`)),
        fix: {
          summary: "Make the reject button send a denied consent update and block non-Google tags on reject.",
          steps: [
            "Check that your banner calls a consent update with denied values on reject.",
            "Make sure no tag fires on a plain page view trigger without a consent check.",
            "Re-test: reject, browse two pages, confirm no marketing hits and only denied Google pings.",
          ],
        },
      },
    ];
  },
};

const modeV2Missing: Rule = {
  id: "consent.mode_v2_missing",
  run(ctx) {
    const google = ctx.hits.filter((h) => GOOGLE_VENDORS.includes(h.vendor) && hasConsentSignals(h));
    if (google.length === 0) return [];
    const missing = google.filter((h) => {
      const u = current(h, "ad_user_data");
      const p = current(h, "ad_personalization");
      return u === undefined || u === "unset" || p === undefined || p === "unset";
    });
    if (missing.length !== google.length) return [];
    const ads = ctx.hits.some((h) => AD_VENDORS.includes(h.vendor) && GOOGLE_VENDORS.includes(h.vendor));
    return [
      {
        id: this.id,
        title: "Consent Mode v2 signals are missing",
        severity: ads ? "high" : "medium",
        why: "Google tags send the older consent signals only, without ad_user_data and ad_personalization. Google Ads needs both for EU audiences and conversion modelling.",
        conversionTypes: [],
        vendors: vendorsOf(missing),
        impact: ads ? 4 : 3,
        confidence: 3,
        reach: 3,
        effort: 1,
        reproduced: true,
        evidence: sampleHits(missing, 3).map((h) => hitEvidence(h, "Consent signals without the two v2 keys")),
        fix: {
          summary: "Send all four consent keys in the default and in every update.",
          steps: [
            "Add ad_user_data and ad_personalization to your Consent Mode default (denied) and update calls.",
            "If you use a certified CMP, switch on its Consent Mode v2 option or GTM template.",
            "Re-test and check the gcd value carries all four keys.",
          ],
        },
      },
    ];
  },
};

const noDefault: Rule = {
  id: "consent.no_default",
  run(ctx) {
    const withGcd = ctx.hits.filter((h) => GOOGLE_VENDORS.includes(h.vendor) && !!h.consent?.raw.gcd);
    const bad = withGcd.filter((h) => {
      const k = h.consent?.keys;
      return k?.ad_storage?.default === "unset" || k?.analytics_storage?.default === "unset";
    });
    if (bad.length === 0) return [];
    return [
      {
        id: this.id,
        title: "No Consent Mode default is set",
        severity: "medium",
        why: "Google tags run before a consent default exists. Until the banner loads, tags guess the state instead of starting as denied.",
        conversionTypes: [],
        vendors: vendorsOf(bad),
        impact: 3,
        confidence: 3,
        reach: 3,
        effort: 1,
        reproduced: true,
        evidence: [
          ...sampleHits(bad, 3).map((h) => hitEvidence(h, "gcd shows no default for a storage key")),
          note("Google does not publish the gcd letter map. We show the raw value; unknown letters stay unknown."),
        ],
        fix: {
          summary: "Set a denied default for all four keys before any Google tag loads.",
          steps: [
            "Place the Consent Mode default call above the GTM or gtag snippet, or use the Consent Initialization trigger in GTM.",
            "Set ad_storage, analytics_storage, ad_user_data and ad_personalization to denied for EU visitors.",
            "Re-test and confirm the gcd value shows a default for every key.",
          ],
        },
      },
    ];
  },
};

const cmpWithoutConsentMode: Rule = {
  id: "consent.cmp_without_consent_mode",
  appliesTo: (ctx) => bannerSeen(ctx),
  run(ctx) {
    const google = ctx.hits.filter((h) => GOOGLE_VENDORS.includes(h.vendor));
    if (google.length === 0 || google.some(hasConsentSignals)) return [];
    const cmp = ctx.capture.scenarios.find((r) => r.cmp)?.cmp;
    return [
      {
        id: this.id,
        title: "Consent banner is not connected to Google Consent Mode",
        severity: "high",
        why: `You have a consent banner${cmp ? ` (${cmp})` : ""}, but Google tags carry no consent signal. Google cannot tell what the visitor chose.`,
        conversionTypes: [],
        vendors: vendorsOf(google),
        impact: 4,
        confidence: 3,
        reach: 3,
        effort: 2,
        reproduced: true,
        evidence: sampleHits(google, 3).map((h) => hitEvidence(h, "Google hit with no gcs or gcd")),
        fix: {
          summary: "Turn on Consent Mode v2 in your banner or GTM and pass every choice to Google.",
          steps: [
            "Enable the Consent Mode integration of your consent platform, or add its GTM template.",
            "Set denied defaults for all four keys and send an update on accept and on reject.",
            "Re-test all three cases: no choice, accept, reject.",
          ],
        },
      },
    ];
  },
};

const noBanner: Rule = {
  id: "consent.no_banner",
  appliesTo: (ctx) => noBannerAnywhere(ctx),
  run(ctx) {
    const tracking = ctx.hits.filter((h) => isTracking(h) && effectivelyGranted(h));
    if (tracking.length === 0) return [];
    return [
      {
        id: this.id,
        title: "Tracking runs but no consent banner was detected",
        severity: "critical",
        why: "No consent banner detected from our EU test location, yet tracking tags ran. Visitors get no choice before data is sent. This is not legal advice.",
        conversionTypes: [],
        vendors: vendorsOf(tracking),
        impact: 5,
        confidence: 2,
        reach: 3,
        effort: 2,
        reproduced: true,
        evidence: [
          note(`Region: ${ctx.capture.region}. Banner outcome: no_banner in every scenario we ran.`),
          ...sampleHits(tracking, 4).map((h) => hitEvidence(h, `${h.vendor} ${h.eventName} with no banner shown`)),
        ],
        fix: {
          summary: "Add a consent banner for EU visitors and gate tags on it.",
          steps: [
            "Pick a consent platform that supports Google Consent Mode v2.",
            "Show it to EU visitors and set denied defaults until they choose.",
            "Gate every marketing and analytics tag on the choice.",
          ],
        },
      },
    ];
  },
};

const bannerNotTestable: Rule = {
  id: "consent.banner_not_testable",
  run(ctx) {
    const runs = ctx.capture.scenarios.filter((r) => r.banner === "not_clickable" || r.banner === "blocked_by_bot_protection");
    if (runs.length === 0) return [];
    const blocked = runs.some((r) => r.banner === "blocked_by_bot_protection");
    const shots = runs.flatMap((r) => r.screenshots).slice(0, 2);
    return [
      {
        id: this.id,
        title: blocked ? "Bot protection stopped part of the consent test" : "We could not click the consent banner",
        severity: "low",
        why: blocked
          ? "The site blocked our test browser, so some consent checks could not run. This is a gap in the test, not a failure of your setup."
          : "We found a banner but not the button we needed, so that consent case was not tested. This is a gap in the test, not a failure of your setup.",
        conversionTypes: [],
        vendors: [],
        impact: 1,
        confidence: 1,
        reach: 1,
        effort: 1,
        reproduced: false,
        evidence: [
          note("Scenarios affected", runs.map((r) => ({ scenario: r.scenario, banner: r.banner }))),
          ...shots.map((s) => ({ kind: "screenshot" as const, caption: s.caption, ref: s.key })),
        ],
        fix: {
          summary: "Nothing to fix on your side. The paid audit tests this case by hand.",
          steps: ["Check the banner has visible accept and reject buttons on the first layer."],
        },
      },
    ];
  },
};

export const CONSENT_RULES: Rule[] = [
  firesBeforeConsent,
  grantedAfterReject,
  noBanner,
  cmpWithoutConsentMode,
  modeV2Missing,
  noDefault,
  bannerNotTestable,
];

