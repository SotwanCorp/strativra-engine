import type { Capture, DecodedHit, Finding } from "../../types.ts";

export interface RuleContext {
  capture: Capture;
  hits: DecodedHit[];
  siteHost: string;
}

export interface Rule {
  /** Matches the Finding id it emits (one aggregated finding per rule). */
  id: string;
  appliesTo?: (ctx: RuleContext) => boolean;
  run: (ctx: RuleContext) => Finding[];
}
