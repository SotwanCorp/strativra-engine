/**
 * Factory for "third-party tool" adapters (schedulers, embedded forms, chat):
 * the tool is recognised by iframe src, link href, script src, CSS markers or
 * window globals. One hit per tool per page, best evidence wins.
 */
import type { ConversionType } from "../../types.ts";
import type { Adapter, AdapterHit, ContactChannel, PageSnapshot, PointMeta } from "./types.ts";
import { urlMatches } from "./hosts.ts";

export interface ToolSpec {
  id: string;
  name: string;
  type: ConversionType;
  domains: string[];
  /** Optional path prefix the URL must start with (Google Forms: "/forms"). */
  pathPrefix?: string;
  /** Extra URL test (overrides domains/pathPrefix when given). */
  urlTest?: (href: string) => boolean;
  markers?: string[];
  globals?: string[];
  keywords?: string[];
  /** Whether a plain link to the tool counts (true for schedulers and form links). */
  links?: boolean;
  channel?: ContactChannel;
  /** Noun used in labels: "booking", "form", "chat". */
  noun: string;
}

function matchUrl(spec: ToolSpec, href: string): boolean {
  if (!href) return false;
  return spec.urlTest ? spec.urlTest(href) : urlMatches(href, spec.domains, spec.pathPrefix);
}

export function toolHit(spec: ToolSpec, s: PageSnapshot): AdapterHit | null {
  const base: PointMeta = { vendor: spec.name, walkable: true };
  if (spec.channel) base.channel = spec.channel;
  const make = (embed: PointMeta["embed"], label: string, confidence: number, selector?: string): AdapterHit => ({
    type: spec.type,
    label,
    selector,
    confidence,
    key: `${spec.type}:${spec.id}`,
    meta: { ...base, embed },
  });
  const iframe = s.iframes.find((f) => matchUrl(spec, f.src));
  if (iframe) return make("iframe", `${spec.name} ${spec.noun} embed`, 0.9, iframe.selector);
  for (const m of spec.markers ?? []) {
    const hit = s.markers[m];
    if (hit && hit.count > 0) {
      const h = make("inline", `${spec.name} ${spec.noun} embed`, 0.85, hit.selector);
      if (hit.formSelector) h.formSelector = hit.formSelector;
      return h;
    }
  }
  if (spec.links) {
    const link = s.links.find((l) => matchUrl(spec, l.href));
    if (link) {
      const h = make("link", `${spec.name} ${spec.noun} link`, 0.75, link.selector);
      h.meta.href = link.href;
      return h;
    }
  }
  const script = s.scripts.some((src) => matchUrl(spec, src));
  const global = (spec.globals ?? []).some((g) => s.globals.includes(g));
  const keyword = (spec.keywords ?? []).some((k) => s.keywords.includes(k));
  if (script || global || keyword) {
    return make("script", `${spec.name} ${spec.noun} (loaded, no visible embed found)`, spec.type === "contact_click" ? 0.8 : 0.5);
  }
  return null;
}

export function toolAdapter(spec: ToolSpec): Adapter {
  return {
    id: spec.id,
    markers: spec.markers,
    globals: spec.globals,
    keywords: spec.keywords,
    isPresent: (s) => toolHit(spec, s) !== null,
    detect: (s) => {
      const h = toolHit(spec, s);
      return h ? [h] : [];
    },
  };
}
