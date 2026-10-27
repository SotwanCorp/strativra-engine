/**
 * Google Consent Mode decoding (gcs, gcd, dma, npa).
 *
 * gcs = "G1xy": x = ad_storage, y = analytics_storage; 1 granted, 0 denied,
 * "-" not set. Only the current state is carried.
 *
 * gcd = "1" + four slot letters separated by digits + "5", e.g. "13r3r3r3r5"
 * or "11p1p1p1p5". Slot order: ad_storage, analytics_storage, ad_user_data,
 * ad_personalization. Each letter encodes the default state and the update.
 *
 * Google does NOT publish the gcd letter map. The map below is third-party
 * reverse engineered and may change without notice, so the raw string is
 * always kept and unknown letters are reported as "unknown".
 * Sources:
 *   https://stape.io/blog/google-consent-mode-v2
 *   https://developers.google.com/tag-platform/security/concepts/consent-mode
 * Cross-checked 2026-10-23 via web search: consentmanager.net and the
 * UniConsent "consent data validator" give the same l/m/n and p..v reading
 * (m = no default, update denied; n = no default, update granted).
 */
import type { ConsentKey, ConsentSignals, ConsentValue } from "../../types.ts";

const SLOTS: ConsentKey[] = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"];

type Pair = { default: ConsentValue; update: ConsentValue };

export const GCD_LETTERS: Readonly<Record<string, Pair>> = {
  l: { default: "unset", update: "unset" },
  p: { default: "denied", update: "unset" },
  q: { default: "denied", update: "denied" },
  r: { default: "denied", update: "granted" },
  t: { default: "granted", update: "unset" },
  u: { default: "granted", update: "denied" },
  v: { default: "granted", update: "granted" },
  m: { default: "unset", update: "denied" },
  n: { default: "unset", update: "granted" },
};

function current(p: Pair): ConsentValue {
  return p.update !== "unset" ? p.update : p.default;
}

function get(params: URLSearchParams | Record<string, string>, k: string): string | undefined {
  if (params instanceof URLSearchParams) {
    const v = params.get(k);
    return v === null ? undefined : v;
  }
  const v = params[k];
  return typeof v === "string" ? v : undefined;
}

function gcsBit(c: string | undefined): ConsentValue {
  if (c === "1") return "granted";
  if (c === "0") return "denied";
  if (c === "-") return "unset";
  return "unknown";
}

export function decodeConsent(
  params: URLSearchParams | Record<string, string>,
): ConsentSignals | undefined {
  try {
    const gcs = get(params, "gcs");
    const gcd = get(params, "gcd");
    const dma = get(params, "dma");
    const npa = get(params, "npa");
    if (gcs === undefined && gcd === undefined && dma === undefined && npa === undefined) return undefined;

    const out: ConsentSignals = { raw: {}, keys: {}, unknownLetters: [] };
    if (gcs !== undefined) out.raw.gcs = gcs;
    if (gcd !== undefined) out.raw.gcd = gcd;
    if (dma !== undefined) out.raw.dma = dma;
    if (npa !== undefined) out.raw.npa = npa;

    // gcd: the slot letters, in order. Digits are separators / framing.
    if (gcd) {
      const letters = (gcd.match(/[a-zA-Z]/g) ?? []).slice(0, SLOTS.length);
      letters.forEach((raw, i) => {
        const letter = raw.toLowerCase();
        const pair = GCD_LETTERS[letter];
        const key = SLOTS[i];
        if (pair) {
          out.keys[key] = { default: pair.default, update: pair.update, current: current(pair) };
        } else {
          out.keys[key] = { default: "unknown", update: "unknown", current: "unknown" };
          if (!out.unknownLetters.includes(raw)) out.unknownLetters.push(raw);
        }
      });
    }

    // gcs fills the current state of ad/analytics storage when gcd did not.
    const m = gcs ? /^G1([01-])([01-])$/.exec(gcs.trim()) : null;
    if (m) {
      const fill: Array<[ConsentKey, ConsentValue]> = [
        ["ad_storage", gcsBit(m[1])],
        ["analytics_storage", gcsBit(m[2])],
      ];
      for (const [key, val] of fill) {
        const existing = out.keys[key];
        if (!existing) {
          out.keys[key] = { default: "unknown", update: "unknown", current: val };
        } else if (existing.current === "unknown") {
          existing.current = val;
        }
      }
    }
    return out;
  } catch {
    return undefined;
  }
}
