/** Adapter registry + platform hints. */
import type { Adapter, PageSnapshot } from "./types.ts";
import { shopifyAdapter } from "./shopify.ts";
import { woocommerceAdapter } from "./woocommerce.ts";
import { stripeAdapter } from "./stripe.ts";
import { schedulerAdapters } from "./schedulers.ts";
import { formAdapters } from "./forms.ts";
import { chatAdapters } from "./chat.ts";

export const ADAPTERS: Adapter[] = [
  shopifyAdapter,
  woocommerceAdapter,
  stripeAdapter,
  ...schedulerAdapters,
  ...formAdapters,
  ...chatAdapters,
];

const PLATFORM_MARKERS = ["html[data-wf-site]", "[data-framer-name]", "#__framer-badge-container"];

/** Everything the in-page snapshot must look up, merged from all adapters. */
export function snapshotRequest(adapters: Adapter[] = ADAPTERS): { markers: string[]; globals: string[]; keywords: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    markers: uniq([...adapters.flatMap((a) => a.markers ?? []), ...PLATFORM_MARKERS]),
    globals: uniq(adapters.flatMap((a) => a.globals ?? [])),
    keywords: uniq(adapters.flatMap((a) => a.keywords ?? [])),
  };
}

/** Platform/CMS hints (Capture.platformHints). */
export function detectPlatformHints(s: PageSnapshot, adapters: Adapter[] = ADAPTERS): string[] {
  const out = new Set<string>();
  for (const a of adapters) if (a.platform && a.isPresent?.(s)) out.add(a.platform);
  const gen = s.generator.toLowerCase();
  if (gen.includes("wordpress") || s.scripts.some((x) => x.includes("/wp-content/") || x.includes("/wp-includes/"))) out.add("WordPress");
  if (gen.includes("webflow") || s.markers["html[data-wf-site]"]) out.add("Webflow");
  if (gen.includes("framer") || s.markers["#__framer-badge-container"] || s.markers["[data-framer-name]"]) out.add("Framer");
  if (gen.includes("wix") || s.scripts.some((x) => x.includes("static.parastorage.com"))) out.add("Wix");
  if (gen.includes("squarespace") || s.scripts.some((x) => x.includes("squarespace.com"))) out.add("Squarespace");
  if (s.scripts.some((x) => x.includes("cdn.gpteng.co")) || gen.includes("lovable")) out.add("Lovable");
  if (s.markers["html[data-wf-site]"]) out.add("Webflow");
  return [...out];
}

export type { Adapter, AdapterHit, PageSnapshot, PointMeta } from "./types.ts";
