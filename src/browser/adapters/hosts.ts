/** Host helpers shared by discovery, adapters and the walker. Pure. */

export function safeUrl(href: string, base?: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

/** Lowercase, no port, no leading "www.". */
export function bareHost(host: string): string {
  return host.toLowerCase().trim().replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
}

/** host equals domain or is a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === domain || h.endsWith("." + domain);
}

/** Same site: equal hosts (ignoring www/port) or one is a subdomain of the other. */
export function isSameSite(host: string, siteHost: string): boolean {
  const a = bareHost(host);
  const b = bareHost(siteHost);
  if (!a || !b) return false;
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

/** Payment and hosted-checkout hosts. The walker never navigates to these. */
export const PAYMENT_DOMAINS = [
  "stripe.com", "stripe.network", "paypal.com", "paypalobjects.com", "adyen.com", "klarna.com",
  "mollie.com", "braintreegateway.com", "squareup.com", "square.site", "paddle.com", "lemonsqueezy.com",
  "gumroad.com", "sumup.com", "2checkout.com", "razorpay.com", "payplug.com", "lyra.com", "stancer.com",
  "konnect.network", "paymee.tn", "checkout.com", "worldpay.com", "authorize.net", "shop.app", "pay.shopify.com",
  "checkout.shopify.com", "apple.com", "pay.google.com",
];

export function isPaymentHost(host: string): boolean {
  return PAYMENT_DOMAINS.some((d) => hostMatches(host, d));
}

/** True when the URL points at one of the domains (and, optionally, path prefix). */
export function urlMatches(href: string, domains: string[], pathPrefix?: string): boolean {
  const u = safeUrl(href);
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  if (!domains.some((d) => hostMatches(u.hostname, d))) return false;
  return pathPrefix ? u.pathname.startsWith(pathPrefix) : true;
}

/** Stable short hash (FNV-1a 32-bit, base36). */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
