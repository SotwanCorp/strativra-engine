/** Stored batches (IndexedDB) + session meta -> RecordingInput for build.ts. Pure. */
import type { RecordingInput } from "./build.ts";
import type { RawCookies, RawError, RawIcs, RawNav, RawPush, RawRequest } from "./record.ts";
import type { Session, StoredEvent } from "./store.ts";

export interface MainStatus {
  url: string;
  status: number;
  ts: number;
}

export function assemble(session: Session, events: StoredEvent[], o: { stoppedAt: number; userAgent: string; clientVersion: string }): RecordingInput {
  const requests: RawRequest[] = [];
  const errors: RawError[] = [];
  const dataLayer: RawPush[] = [];
  const ics: RawIcs[] = [];
  const navs: RawNav[] = [];
  const statuses: MainStatus[] = [];
  const cookies: RawCookies[] = [];
  for (const e of events) {
    if (e.s !== session.id) continue;
    switch (e.k) {
      case "req": requests.push(e.d as RawRequest); break;
      case "err": errors.push(e.d as RawError); break;
      case "dl": dataLayer.push(e.d as RawPush); break;
      case "ics": ics.push(e.d as RawIcs); break;
      case "nav": navs.push(e.d as RawNav); break;
      case "status": statuses.push(e.d as MainStatus); break;
      case "cookies": cookies.push(e.d as RawCookies); break;
    }
  }
  // HTTP status of a page load: the main-frame response for the same URL closest in time.
  for (const n of navs) {
    if (n.kind !== "commit") continue;
    let best: MainStatus | undefined;
    for (const s of statuses) {
      if (s.url !== n.url || Math.abs(s.ts - n.ts) > 30_000) continue;
      if (!best || Math.abs(s.ts - n.ts) < Math.abs(best.ts - n.ts)) best = s;
    }
    if (best) n.status = best.status;
  }
  return {
    target: session.target,
    startedAt: session.startedAt,
    stoppedAt: o.stoppedAt,
    userAgent: o.userAgent,
    visitor: session.visitor,
    marker: session.marker,
    requests,
    errors,
    dataLayer,
    ics,
    droppedPushes: session.droppedPushes,
    navs,
    clicks: session.clicks,
    cookies,
    steps: session.steps,
    clientVersion: o.clientVersion,
  };
}
