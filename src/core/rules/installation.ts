import type { CapturedRequest, DecodedHit, Evidence } from "../../types.ts";
import type { Rule, RuleContext } from "./types.ts";
import { hitEvidence, normUrl, note, reachFrom, requestEvidence, routeUrl, sampleHits, uniq } from "./helpers.ts";

function allRequests(ctx: RuleContext): CapturedRequest[] {
  return ctx.capture.scenarios.flatMap((s) => s.requests);
}

function ga4Hits(ctx: RuleContext): DecodedHit[] {
  return ctx.hits.filter((h) => h.vendor === "ga4");
}

function pagesVisited(ctx: RuleContext): number {
  return Math.max(1, uniq(ctx.capture.pages.map((p) => normUrl(p.url))).length);
}

interface TagLoad {
  req: CapturedRequest;
  id: string;
  viaGtm: boolean;
}

/** gtag.js loads for G- ids. GTM-loaded Google tags carry cx=c or a gtm param; hard-coded snippets do not. */
export function gtagLoads(reqs: CapturedRequest[]): TagLoad[] {
  const out: TagLoad[] = [];
  for (const r of reqs) {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    if (!/\/gtag\/js$/.test(u.pathname)) continue;
    const id = u.searchParams.get("id") ?? "";
    if (!/^G-/i.test(id)) continue;
    out.push({ req: r, id: id.toUpperCase(), viaGtm: u.searchParams.get("cx") === "c" || u.searchParams.has("gtm") });
  }
  return out;
}

const noGa4: Rule = {
  id: "install.no_ga4",
  appliesTo: (ctx) => ctx.capture.pages.length > 0,
  run(ctx) {
    if (ga4Hits(ctx).length > 0) return [];
    const accept = ctx.capture.scenarios.find((s) => s.scenario === "accept");
    const acceptTested = !accept || accept.banner === "clicked" || accept.banner === "no_banner";
    return [
      {
        id: this.id,
        title: "No Google Analytics 4 data was sent",
        severity: "high",
        why: acceptTested
          ? "We browsed the site, accepted cookies and saw no GA4 hit. Without it you have no free baseline to check ads and conversions against."
          : "We saw no GA4 hit, but we could not accept cookies, so GA4 may be waiting for consent. Without it you have no baseline to check ads against.",
        conversionTypes: [],
        vendors: ["ga4"],
        impact: 4,
        confidence: acceptTested ? 2 : 1,
        reach: 3,
        effort: 2,
        reproduced: acceptTested,
        evidence: [note(`Pages visited: ${ctx.capture.pages.length}. GA4 hits seen: 0.`, { scenarios: ctx.capture.scenarios.map((s) => ({ scenario: s.scenario, banner: s.banner })) })],
        fix: {
          summary: "Install a GA4 tag on every page, ideally through GTM.",
          steps: [
            "Create a GA4 property and web data stream if you have none.",
            "Add the Google tag with the G- id in GTM, firing on all pages, gated by consent.",
            "Check Realtime in GA4 shows your own visit.",
          ],
        },
      },
    ];
  },
};

const duplicatePageView: Rule = {
  id: "install.duplicate_page_view",
  run(ctx) {
    const groups = new Map<string, DecodedHit[]>();
    for (const h of ga4Hits(ctx)) {
      if (h.eventName !== "page_view") continue;
      const k = `${h.scenario}|${h.accountId ?? ""}|${routeUrl(h.pageUrl)}`;
      const g = groups.get(k) ?? [];
      g.push(h);
      groups.set(k, g);
    }
    const dupes: Array<[DecodedHit, DecodedHit]> = [];
    for (const g of groups.values()) {
      g.sort((a, b) => a.ts - b.ts);
      for (let i = 1; i < g.length; i++) {
        // Two events inside one request are one batch (or our decode of it), not a double install.
        if (g[i].requestId !== g[i - 1].requestId && g[i].ts - g[i - 1].ts <= 2000) dupes.push([g[i - 1], g[i]]);
      }
    }
    if (dupes.length === 0) return [];
    const pages = uniq(dupes.map(([a]) => normUrl(a.pageUrl))).length;
    const evidence: Evidence[] = dupes.slice(0, 3).flatMap(([a, b]) => [
      hitEvidence(a, "First page_view"),
      hitEvidence(b, `Second page_view ${b.ts - a.ts} ms later`),
    ]);
    return [
      {
        id: this.id,
        title: "Page views are counted twice",
        severity: "high",
        why: "One page load sends two page_view hits. Page views double and engagement and conversion rates come out wrong.",
        conversionTypes: [],
        vendors: ["ga4"],
        impact: 4,
        confidence: 3,
        reach: reachFrom(pages, pagesVisited(ctx)),
        effort: 1,
        reproduced: true,
        evidence,
        fix: {
          summary: "Keep one source of page_view per page load.",
          steps: [
            "Look for the GA4 id in both a hard-coded gtag snippet and GTM, or in two GTM tags.",
            "If the site is a single-page app, check the history change trigger does not also fire on the first load.",
            "Remove the extra source and re-test with GTM Preview.",
          ],
        },
      },
    ];
  },
};

const multipleGa4Ids: Rule = {
  id: "install.multiple_ga4_ids",
  run(ctx) {
    const ids = uniq(ga4Hits(ctx).map((h) => h.accountId).filter((x): x is string => !!x && /^G-/i.test(x)));
    if (ids.length < 2) return [];
    const samples = ids.map((id) => ga4Hits(ctx).find((h) => h.accountId === id)).filter((h): h is DecodedHit => !!h);
    return [
      {
        id: this.id,
        title: "Data goes to more than one GA4 property",
        severity: "medium",
        why: `We saw ${ids.length} GA4 ids. That can be on purpose, but often one is a forgotten old property that splits or doubles your data.`,
        conversionTypes: [],
        vendors: ["ga4"],
        impact: 2,
        confidence: 2,
        reach: 3,
        effort: 1,
        reproduced: true,
        evidence: samples.slice(0, 4).map((h) => hitEvidence(h, `Hit to ${h.accountId}`)),
        fix: {
          summary: "Confirm which GA4 property is the real one and remove or document the others.",
          steps: ["List every G- id we found and who owns each.", "Remove the ones nobody uses from the site and GTM."],
        },
      },
    ];
  },
};

const tagLoadedTwice: Rule = {
  id: "install.tag_loaded_twice",
  run(ctx) {
    const loads = gtagLoads(allRequests(ctx));
    const groups = new Map<string, TagLoad[]>();
    for (const l of loads) {
      const k = `${l.req.scenario}|${l.id}|${normUrl(l.req.pageUrl)}`;
      const g = groups.get(k) ?? [];
      g.push(l);
      groups.set(k, g);
    }
    const twice: TagLoad[][] = [];
    for (const g of groups.values()) {
      g.sort((a, b) => a.req.ts - b.req.ts);
      // Only same-mode repeats here; mixed modes are install.gtag_and_gtm_same_id.
      for (let i = 1; i < g.length; i++) {
        if (g[i].viaGtm === g[i - 1].viaGtm && g[i].req.ts - g[i - 1].req.ts <= 5000) {
          twice.push([g[i - 1], g[i]]);
          break;
        }
      }
    }
    if (twice.length === 0) return [];
    return [
      {
        id: this.id,
        title: "The GA4 tag loads twice on the same page",
        severity: "medium",
        why: "The same Google tag script loads twice per page. It wastes load time and often leads to double hits.",
        conversionTypes: [],
        vendors: ["ga4"],
        impact: 2,
        confidence: 3,
        reach: reachFrom(twice.length, pagesVisited(ctx)),
        effort: 1,
        reproduced: true,
        evidence: twice.slice(0, 2).flatMap((pair) => pair.map((l) => requestEvidence(l.req, `gtag.js load for ${l.id}`))),
        fix: {
          summary: "Load each Google tag once per page.",
          steps: ["Search the theme, plugins and GTM for the G- id.", "Keep a single installation."],
        },
      },
    ];
  },
};

const gtagAndGtmSameId: Rule = {
  id: "install.gtag_and_gtm_same_id",
  run(ctx) {
    const loads = gtagLoads(allRequests(ctx));
    const byPage = new Map<string, TagLoad[]>();
    for (const l of loads) {
      const k = `${l.req.scenario}|${l.id}|${normUrl(l.req.pageUrl)}`;
      const g = byPage.get(k) ?? [];
      g.push(l);
      byPage.set(k, g);
    }
    const both: TagLoad[][] = [...byPage.values()].filter((g) => g.some((l) => l.viaGtm) && g.some((l) => !l.viaGtm));
    if (both.length === 0) return [];
    const ids = uniq(both.map((g) => g[0].id));
    const confirmed = ctx.hits.some((h) => h.vendor === "ga4" && h.eventName === "page_view" && ids.includes((h.accountId ?? "").toUpperCase()));
    return [
      {
        id: this.id,
        title: "GA4 is installed twice: in the code and in GTM",
        severity: "high",
        why: `The id ${ids.join(", ")} is loaded by a hard-coded snippet and by GTM. Both send hits, so events can be counted twice.`,
        conversionTypes: [],
        vendors: ["ga4", "gtm"],
        impact: 4,
        confidence: confirmed ? 3 : 2,
        reach: reachFrom(uniq(both.map((g) => normUrl(g[0].req.pageUrl))).length, pagesVisited(ctx)),
        effort: 1,
        reproduced: true,
        evidence: both[0].slice(0, 2).map((l) => requestEvidence(l.req, l.viaGtm ? `Loaded by GTM (${l.id})` : `Hard-coded gtag snippet (${l.id})`)),
        fix: {
          summary: "Pick one installation: remove the hard-coded gtag snippet and keep GTM.",
          steps: [
            "Find the gtag snippet in the theme, a plugin or the site builder settings.",
            "Remove it, keep the Google tag in GTM.",
            "Re-test: one page_view per page load.",
          ],
        },
      },
    ];
  },
};

const uaLegacy: Rule = {
  id: "install.ua_legacy",
  run(ctx) {
    const reqs = allRequests(ctx).filter((r) => {
      try {
        const u = new URL(r.url);
        if (!/google-analytics\.com$/.test(u.hostname)) return false;
        if (/\/analytics\.js$|\/ga\.js$/.test(u.pathname)) return true;
        if (/\/(r\/)?collect$/.test(u.pathname) && (u.searchParams.get("v") === "1" || /UA-\d+/.test(r.url + (r.postData ?? "")))) return true;
      } catch {
        return false;
      }
      return false;
    });
    const hits = ctx.hits.filter((h) => /^UA-/i.test(h.accountId ?? ""));
    if (reqs.length === 0 && hits.length === 0) return [];
    return [
      {
        id: this.id,
        title: "Old Universal Analytics code is still on the site",
        severity: "low",
        why: "Universal Analytics stopped processing data. The old code only adds weight to the page.",
        conversionTypes: [],
        vendors: ["other"],
        impact: 1,
        confidence: 3,
        reach: 3,
        effort: 1,
        reproduced: true,
        evidence: [
          ...reqs.slice(0, 2).map((r) => requestEvidence(r, "Universal Analytics request")),
          ...sampleHits(hits, 2).map((h) => hitEvidence(h, "UA- id")),
        ],
        fix: { summary: "Remove the Universal Analytics snippet and its GTM tags.", steps: ["Delete analytics.js or UA- tags from the site and GTM."] },
      },
    ];
  },
};

const spaMissingPageView: Rule = {
  id: "install.spa_missing_page_view",
  appliesTo: (ctx) => ctx.capture.pages.some((p) => p.via === "spa_route"),
  run(ctx) {
    const ga4 = ga4Hits(ctx);
    if (ga4.length === 0) return [];
    const seen = new Set<string>();
    for (const h of ga4) {
      if (h.eventName !== "page_view") continue;
      seen.add(routeUrl(h.pageUrl));
      const loc = h.params.page_location ?? h.params.dl;
      if (typeof loc === "string") seen.add(routeUrl(loc));
    }
    const routes = ctx.capture.pages.filter((p) => p.via === "spa_route");
    const missing = routes.filter((p) => !seen.has(routeUrl(p.url)));
    if (missing.length === 0) return [];
    return [
      {
        id: this.id,
        title: "Page changes in your app are not tracked",
        severity: "high",
        why: `${missing.length} of ${routes.length} in-app page changes sent no page_view. Those pages are invisible in GA4 and conversions get the wrong landing page.`,
        conversionTypes: [],
        vendors: ["ga4"],
        impact: 4,
        confidence: 3,
        reach: reachFrom(missing.length, pagesVisited(ctx)),
        effort: 2,
        reproduced: true,
        evidence: missing.slice(0, 4).map((p) => note(`No page_view for in-app route`, { url: p.url })),
        fix: {
          summary: "Send one page_view per route change.",
          steps: [
            "Turn on 'Page changes based on browser history events' in the GA4 enhanced measurement settings, or add a GTM History Change trigger.",
            "Make sure the first load is not counted twice.",
            "Re-test by clicking through three routes.",
          ],
        },
      },
    ];
  },
};

export const INSTALLATION_RULES: Rule[] = [noGa4, duplicatePageView, gtagAndGtmSameId, tagLoadedTwice, multipleGa4Ids, spaMissingPageView, uaLegacy];
