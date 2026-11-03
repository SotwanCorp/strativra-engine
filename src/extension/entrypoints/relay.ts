/**
 * ISOLATED world, document_start: forwards what the MAIN-world bridge hands over to the service
 * worker, plus the time of each real page click or Enter/Space key press (no target, no text: only
 * the moment, used to place the consent marker and guided steps). Ignored by the service worker for
 * any tab other than the one being recorded.
 */
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

export default defineUnlistedScript(() => {
  const g = globalThis as unknown as { __strvRelay?: boolean };
  if (g.__strvRelay) return;
  g.__strvRelay = true;
  const top = window === window.top;
  const send = (m: object) => {
    try {
      chrome.runtime.sendMessage(m).catch(() => {});
    } catch {
      /* extension reloaded */
    }
  };
  document.addEventListener("__strv_state", (e) => {
    const d = (e as CustomEvent).detail;
    if (typeof d === "string" && d.length < 4_000_000) send({ type: "page_state", state: d, top, href: location.href });
  });
  const click = (e: Event) => e.isTrusted && send({ type: "page_click", t: Date.now() });
  addEventListener("pointerdown", click, true);
  addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && click(e), true);
  chrome.runtime.onMessage.addListener((m: unknown) => {
    if (m && typeof m === "object" && (m as { type?: string }).type === "flush") document.dispatchEvent(new CustomEvent("__strv_flush"));
    return false;
  });
});
