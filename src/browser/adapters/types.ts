/**
 * Adapter contract. Adapters only help detect and interpret a conversion
 * point (SPEC section 2). They never act on the page: they read a
 * PageSnapshot (collected once, in-page, by discover.ts) and return hits.
 * Pure functions, so they are unit-testable without a browser.
 */
import type { ConversionType } from "../../types.ts";

export interface SnapshotLink {
  /** Absolute href (a.href). */
  href: string;
  text: string;
  selector: string;
  inNav: boolean;
  download: boolean;
}

export interface SnapshotIframe {
  src: string;
  selector: string;
  title: string;
}

export interface SnapshotButton {
  tag: string;
  text: string;
  selector: string;
  name: string;
  type: string;
  classes: string;
  /** Has data-product-id / data-product_id / data-variant-id. */
  productId: boolean;
  /** Absolute action of the enclosing form, "" when none. */
  formAction: string;
  href: string;
}

export interface SnapshotMarker {
  count: number;
  /** cssPath of the first match. */
  selector: string;
  /** cssPath of the first match's form (itself or closest), when any. */
  formSelector?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  bodyClass: string;
  generator: string;
  ogType: string;
  jsonLdTypes: string[];
  scripts: string[];
  iframes: SnapshotIframe[];
  links: SnapshotLink[];
  buttons: SnapshotButton[];
  forms: Array<{ action: string; selector: string; classes: string }>;
  /** Keyed by the marker CSS selector that was asked for. Only matches are present. */
  markers: Record<string, SnapshotMarker>;
  /** Window globals (from the asked list) that are defined. */
  globals: string[];
  /** Keywords (from the asked list) found in inline scripts. */
  keywords: string[];
}

export type ContactChannel = "phone" | "email" | "whatsapp" | "chat";

/** Walk hints kept beside a ConversionPoint (see discover.ts pointMeta). */
export interface PointMeta {
  channel?: ContactChannel;
  /** Human tool name: "Calendly", "Contact Form 7", "Intercom". */
  vendor?: string;
  href?: string;
  /** False when the point must not be walked beyond viewing it (hosted checkout links). */
  walkable?: boolean;
  /** URL of the same-origin iframe holding the form, when not the main frame. */
  frameUrl?: string;
  formKind?: string;
  embed?: "iframe" | "link" | "inline" | "script" | "dom";
  purchase?: "add_to_cart" | "product_page" | "cart_link" | "hosted_checkout";
  productPage?: boolean;
  cartUrl?: string;
}

export interface AdapterHit {
  type: ConversionType;
  label: string;
  selector?: string;
  confidence: number;
  /** Dedupe key within one page, e.g. "booking:calendly", "purchase:add_to_cart". */
  key: string;
  meta: PointMeta;
  /** Set when the hit interprets a DOM form also seen by the classifier. */
  formSelector?: string;
}

export interface Adapter {
  id: string;
  /** Platform hint name when the adapter identifies a platform/CMS. */
  platform?: string;
  /** CSS selectors to look up in the snapshot. */
  markers?: string[];
  /** Window globals to look up. */
  globals?: string[];
  /** Substrings to look up in inline scripts. */
  keywords?: string[];
  /** Platform presence (for platformHints). Optional. */
  isPresent?(s: PageSnapshot): boolean;
  detect(s: PageSnapshot): AdapterHit[];
}
