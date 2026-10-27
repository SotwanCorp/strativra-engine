/** Shopify: platform + add to cart via /cart/add forms or /cart/add.js. */
import type { Adapter, PageSnapshot } from "./types.ts";

const ATC_MARKERS = [
  "form[action*='/cart/add'] button[name='add']",
  "form[action*='/cart/add'] [type='submit']",
  "form[action*='/cart/add']",
];

function present(s: PageSnapshot): boolean {
  return (
    s.globals.includes("Shopify") ||
    s.scripts.some((src) => /(^https?:)?\/\/cdn\.shopify\.com\//.test(src) || src.includes("/cdn/shop/")) ||
    s.keywords.includes("Shopify.shop") ||
    s.keywords.includes("/cart/add.js")
  );
}

export const shopifyAdapter: Adapter = {
  id: "shopify",
  platform: "Shopify",
  markers: ATC_MARKERS,
  globals: ["Shopify"],
  keywords: ["Shopify.shop", "/cart/add.js"],
  isPresent: present,
  detect(s) {
    if (!present(s)) return [];
    for (const m of ATC_MARKERS) {
      const hit = s.markers[m];
      if (hit && hit.count > 0) {
        return [{
          type: "purchase",
          label: "Add to cart (Shopify)",
          selector: hit.selector,
          confidence: 0.9,
          key: "purchase:add_to_cart",
          meta: { vendor: "Shopify", purchase: "add_to_cart", walkable: true },
        }];
      }
    }
    return [];
  },
};
