/**
 * Consent marker: the moment the person made their consent choice. Everything recorded before it is
 * phase "pre", everything from it on is "post" (same rule as the engine: ts >= marker is post).
 *
 * Two sources:
 *  - the button ("I clicked Accept" / "I clicked Reject"). People press it a few seconds after the real
 *    click, so the marker moves back to their last click in the page before the press (within 60 s).
 *    Without that, hits fired right after the real click would read as "before consent".
 *  - auto: a gtag consent update push (dataLayer `["consent","update",{...}]`, recorded by the engine's
 *    INIT_SCRIPT as `{ __gtag: [...] }`). For a fresh visitor it only counts after a click in the page
 *    (a push at load is a CMP restoring or defaulting, not a choice). For a returning visitor the first
 *    update push is the stored choice being applied.
 * A button press always wins over an auto marker.
 */
import type { Choice, Marker, Visitor } from "./record.ts";

const GRANT_KEYS = ["analytics_storage", "ad_storage", "ad_user_data", "ad_personalization"];

function argsOf(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as { __gtag?: unknown }).__gtag)) {
    return (payload as { __gtag: unknown[] }).__gtag;
  }
  return null;
}

/** "accept" when the update grants analytics or ads storage, "reject" when it only denies, else null. */
export function consentChoiceFromPush(payload: unknown): Choice | null {
  const a = argsOf(payload);
  if (!a || a[0] !== "consent" || a[1] !== "update") return null;
  const o = a[2];
  if (!o || typeof o !== "object") return null;
  const vals = GRANT_KEYS.map((k) => (o as Record<string, unknown>)[k]).filter((v) => v !== undefined);
  if (vals.length === 0) return null;
  if (vals.some((v) => v === "granted")) return "accept";
  if (vals.every((v) => v === "denied")) return "reject";
  return null;
}

/** Last page interaction in (pressTs - windowMs, pressTs], not before the start; else the press itself. */
export function resolveMarkerTs(pressTs: number, clicks: number[], startedAt: number, windowMs = 60_000): number {
  let best = -Infinity;
  for (const c of clicks) if (c >= startedAt && c <= pressTs && c > pressTs - windowMs && c > best) best = c;
  return Number.isFinite(best) ? best : pressTs;
}

export function buttonMarker(pressTs: number, choice: Choice, clicks: number[], startedAt: number): Marker {
  return { ts: resolveMarkerTs(pressTs, clicks, startedAt), choice, source: "button" };
}

/**
 * Marker from a consent update push at `pushT`, or null when it does not count.
 * The boundary is the click that caused it when that click is at most 5 s earlier.
 */
export function autoMarker(o: { pushT: number; choice: Choice; visitor: Visitor; clicks: number[]; startedAt: number; current?: Marker | null }): Marker | null {
  if (o.current) return null; // first choice wins; the button overrides separately
  if (o.pushT < o.startedAt) return null;
  const before = o.clicks.filter((c) => c >= o.startedAt && c <= o.pushT);
  if (o.visitor === "fresh" && before.length === 0) return null;
  const last = before.length ? Math.max(...before) : -Infinity;
  const ts = o.pushT - last <= 5_000 ? last : o.pushT;
  return { ts, choice: o.choice, source: "auto" };
}
