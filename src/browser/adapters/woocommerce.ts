/** WooCommerce: platform + single/archive add to cart buttons. */
import type { Adapter, PageSnapshot } from "./types.ts";

const MARKERS = ["button.single_add_to_cart_button", ".single_add_to_cart_button", "a.add_to_cart_button", ".add_to_cart_button"];

function present(s: PageSnapshot): boolean {
  return (
    /\bwoocommerce(-page|-js)?\b/.test(s.bodyClass) ||
    s.keywords.includes("wc-ajax") ||
    s.keywords.includes("wc_add_to_cart_params") ||
    s.scripts.some((src) => src.includes("/plugins/woocommerce/")) ||
    MARKERS.some((m) => (s.markers[m]?.count ?? 0) > 0)
  );
}

export const woocommerceAdapter: Adapter = {
  id: "woocommerce",
  platform: "WooCommerce",
  markers: MARKERS,
  keywords: ["wc-ajax", "wc_add_to_cart_params"],
  isPresent: present,
  detect(s) {
    if (!present(s)) return [];
    for (const m of MARKERS) {
      const hit = s.markers[m];
      if (hit && hit.count > 0) {
        const single = m.includes("single");
        return [{
          type: "purchase",
          label: single ? "Add to cart (WooCommerce product page)" : "Add to cart (WooCommerce product list)",
          selector: hit.selector,
          confidence: single ? 0.9 : 0.75,
          key: "purchase:add_to_cart",
          meta: { vendor: "WooCommerce", purchase: "add_to_cart", walkable: true },
        }];
      }
    }
    return [];
  },
};
