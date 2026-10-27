/** Stripe hosted checkout / Payment Links: a purchase point that is never walked beyond the link. */
import type { Adapter } from "./types.ts";
import { urlMatches } from "./hosts.ts";

const isHosted = (href: string) => urlMatches(href, ["buy.stripe.com", "checkout.stripe.com"]);

export const stripeAdapter: Adapter = {
  id: "stripe",
  isPresent: (s) => s.links.some((l) => isHosted(l.href)) || s.scripts.some((src) => urlMatches(src, ["js.stripe.com"])),
  detect(s) {
    const link = s.links.find((l) => isHosted(l.href));
    if (!link) return [];
    return [{
      type: "purchase",
      label: "Stripe hosted checkout link",
      selector: link.selector,
      confidence: 0.85,
      key: "purchase:stripe",
      meta: { vendor: "Stripe", purchase: "hosted_checkout", walkable: false, href: link.href, embed: "link" },
    }];
  },
};
