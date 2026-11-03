/**
 * MAIN world, document_start, registered only for the recorded site (plus best-effort injection into
 * frames from other sites). It is the engine's INIT_SCRIPT, imported as code at build time (see
 * wxt.config.ts), followed by a small bridge: every 500 ms, on pagehide and on request it drains
 * `window.__strvRead()` and hands the copies to the ISOLATED relay as a JSON string on a DOM event.
 * No data goes anywhere else.
 */
import "virtual:strv-init-script";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

export default defineUnlistedScript(() => {
  const w = window as unknown as { __strvRead?: () => { dataLayer: unknown[]; dropped: number; ics: unknown } };
  const read = w.__strvRead;
  if (typeof read !== "function") return;
  // Keep our own references: page scripts that run later cannot swap them.
  const doc = document;
  const dispatch = doc.dispatchEvent.bind(doc);
  const CE = CustomEvent;
  const stringify = JSON.stringify;
  const now = Date.now;
  const every = setInterval;
  let lastIcs = "";

  function flush(force: boolean) {
    let r: { dataLayer: unknown[]; dropped: number; ics: unknown };
    try {
      r = read!();
    } catch {
      return;
    }
    const ics = stringify(r.ics ?? null);
    if (!force && r.dataLayer.length === 0 && !r.dropped && ics === lastIcs) return;
    lastIcs = ics;
    try {
      dispatch(new CE("__strv_state", { detail: stringify({ t: now(), dl: r.dataLayer, dropped: r.dropped, ics: r.ics ?? null }) }));
    } catch {
      /* unserializable: skip this round */
    }
  }

  every(() => flush(false), 500);
  addEventListener("pagehide", () => flush(true), true);
  doc.addEventListener("visibilitychange", () => doc.visibilityState === "hidden" && flush(true), true);
  doc.addEventListener("__strv_flush", () => flush(true));
});
