/** Messages between the side panel, the content scripts and the service worker. */
import type { ScanObject } from "./api.ts";
import type { ReviewSummary } from "./prepare.ts";
import type { Choice, Visitor } from "./record.ts";
import type { Session } from "./store.ts";

/** From the side panel (an extension page). */
export type PanelMessage =
  | { type: "start"; tabId: number; url: string; visitor: Visitor; templateId?: "lead" | "ecommerce" }
  | { type: "status" }
  | { type: "marker"; choice: Choice }
  | { type: "step"; status: "done" | "skipped" }
  | { type: "stop" }
  | { type: "review" }
  | { type: "removeHost"; host: string }
  | { type: "upload" }
  | { type: "polled"; reportUrl?: string; finished: boolean }
  | { type: "discard" };

/** From the ISOLATED relay content script. */
export type RelayMessage =
  | { type: "page_state"; state: string; top: boolean; href: string }
  | { type: "page_click"; t: number };

export interface Reply<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface StatusData {
  session: Session | null;
}

export interface ReviewData {
  summary: ReviewSummary;
  session: Session | null;
}

export interface UploadData {
  scan: ScanObject;
  reductions: string[];
}
