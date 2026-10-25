/**
 * Service worker: records Mode B, prepares and uploads it.
 *
 * Recording (only for the one tab the person chose, only between Start and Stop):
 *  - webRequest.onBeforeRequest (requestBody: every raw chunk concatenated; bodies only for tracking
 *    destinations and first-party collect paths; headers are never read), onErrorOccurred -> failed,
 *    onCompleted for the page status
 *  - webNavigation for the top-level URL, pages and SPA routes
 *  - the engine's INIT_SCRIPT in the MAIN world at document_start (registered for the site only),
 *    relayed by an ISOLATED script: dataLayer copies, gtag consent state, page click times
 *  - cookie names and domains of the site (values are dropped as soon as Chrome returns them)
 * Batches go to IndexedDB every second: Chrome stops idle service workers, so nothing lives only in memory.
 * Nothing is sent anywhere until the person presses Upload on the review screen.
 */
import { defineBackground } from "wxt/utils/define-background";
import { isTrackingUrl, registrableDomain } from "../../browser/capture.ts";
import { UploadError } from "../../core/upload.ts";
import { ApiError, DEFAULT_BASE, normalizeBaseUrl, uploadCapture } from "../lib/api.ts";
import { assemble } from "../lib/assemble.ts";
import { bodyToString, type RequestBodyLike } from "../lib/body.ts";
import { buildCapture } from "../lib/build.ts";
import { autoMarker, buttonMarker, consentChoiceFromPush } from "../lib/consent.ts";
import type { PanelMessage, RelayMessage, Reply } from "../lib/messages.ts";
import { PackError, packForUpload, redactForUpload, removeHost, summarize } from "../lib/prepare.ts";
import {
  basePattern, originsToRemove, recordableUrl, shouldKeepBody, siteMatchPatterns,
  type RawRequest,
} from "../lib/record.ts";
import {
  appendEvents, clearEvents, clearPrepared, getPrepared, getSession, getSettings, putPrepared, readEvents, setSession,
  type Session,
} from "../lib/store.ts";
import { getTemplate } from "../lib/templates.ts";

const SCRIPT_IDS = ["strv-main", "strv-relay"];
const MAX_CLICKS = 2000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default defineBackground({
  type: "module",
  main() {
    let session: Session | null = null;
    let loaded = false;
    const pending: Array<() => void> = [];
    let topUrl = "";
    let lastIcs = "";
    let queue: Array<{ k: string; d: unknown }> = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushing: Promise<void> = Promise.resolve();
    let lastCookieSnap = 0;

    const ready = getSession()
      .then((s) => {
        session = s;
        if (s) topUrl = s.target;
      })
      .catch(() => {})
      .finally(() => {
        loaded = true;
        for (const f of pending.splice(0)) f();
      });

    const whenLoaded = (f: () => void) => (loaded ? f() : void pending.push(f));
    const recording = (): boolean => !!session && (session.state === "recording" || session.state === "stopping");
    const inTab = (tabId: number | undefined) => recording() && tabId !== undefined && tabId === session!.tabId;

    function flush(): Promise<void> {
      flushing = flushing.then(async () => {
        const batch = queue;
        queue = [];
        const s = session;
        if (!s) return;
        if (batch.length) await appendEvents(s.id, batch).catch(() => {});
        await setSession(s).catch(() => {});
      });
      return flushing;
    }

    function enqueue(k: string, d: unknown) {
      if (!session) return;
      queue.push({ k, d });
      if (k === "req") {
        session.counts.requests++;
        if (isTrackingUrl((d as RawRequest).url)) session.counts.tracking++;
      } else if (k === "dl") session.counts.dataLayer++;
      flushTimer ??= setTimeout(() => {
        flushTimer = undefined;
        void flush();
      }, 1000);
    }

    function siteHost(): string {
      try {
        return new URL(topUrl || session?.target || "").hostname;
      } catch {
        return "";
      }
    }

    /** Names and domains of the site's cookies. Values never leave this function. */
    async function snapshotCookies(force = false) {
      if (!session) return;
      const now = Date.now();
      if (!force && now - lastCookieSnap < 2000) return;
      lastCookieSnap = now;
      const host = siteHost();
      if (!host) return;
      const domain = /^[\d.]+$/.test(host) || !host.includes(".") ? host : registrableDomain(host);
      try {
        const list = await chrome.cookies.getAll({ domain });
        enqueue("cookies", { ts: now, list: list.map((c) => ({ name: c.name, domain: c.domain })) });
      } catch {
        /* no permission for that host */
      }
    }

    async function unregisterScripts() {
      await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }).catch(() => {});
    }

    /** Frames from other sites (a CMP, an embedded form) get the scripts injected on commit, best effort. */
    function injectFrame(tabId: number, frameId: number, url: string) {
      const u = recordableUrl(url);
      if (!u || !session) return;
      if (registrableDomain(u.hostname) === registrableDomain(siteHost())) return; // registered scripts cover it
      const target = { tabId, frameIds: [frameId] };
      chrome.scripting.executeScript({ target, files: ["main-world.js"], world: "MAIN", injectImmediately: true }).catch(() => {});
      chrome.scripting.executeScript({ target, files: ["relay.js"], world: "ISOLATED", injectImmediately: true }).catch(() => {});
    }

    async function removeRecordingPermissions(base: string) {
      try {
        const granted = (await chrome.permissions.getAll()).origins ?? [];
        const required = chrome.runtime.getManifest().host_permissions ?? [];
        const remove = originsToRemove(granted, [...required, basePattern(base)]);
        if (remove.length) await chrome.permissions.remove({ origins: remove });
      } catch {
        /* nothing to remove */
      }
    }

    async function apiBase(): Promise<{ base: string; key: string } | null> {
      const s = await getSettings();
      if (!s?.key) return null;
      return { base: normalizeBaseUrl(s.base) ?? DEFAULT_BASE, key: s.key };
    }

    /* ------------------------------ network ------------------------------ */

    chrome.webRequest.onBeforeRequest.addListener(
      (d) => {
        whenLoaded(() => {
          if (!inTab(d.tabId) || !/^(https?|wss?):/i.test(d.url)) return;
          const rec: RawRequest = {
            rid: d.requestId,
            url: d.url,
            method: d.method,
            type: d.type,
            ts: d.timeStamp,
            pageUrl: d.type === "main_frame" ? d.url : topUrl || session!.target,
            frameId: d.frameId,
          };
          if (shouldKeepBody(d.url, d.method)) {
            const body = bodyToString(d.requestBody as RequestBodyLike | undefined);
            if (body) rec.body = body;
          }
          enqueue("req", rec);
        });
        return undefined;
      },
      { urls: ["<all_urls>"] },
      ["requestBody"],
    );

    chrome.webRequest.onErrorOccurred.addListener(
      (d) => whenLoaded(() => inTab(d.tabId) && enqueue("err", { rid: d.requestId, error: d.error, ts: d.timeStamp })),
      { urls: ["<all_urls>"] },
    );

    chrome.webRequest.onCompleted.addListener(
      (d) => whenLoaded(() => inTab(d.tabId) && enqueue("status", { url: d.url, status: d.statusCode, ts: d.timeStamp })),
      { urls: ["<all_urls>"], types: ["main_frame"] },
    );

    /* ---------------------------- navigation ----------------------------- */

    chrome.webNavigation.onCommitted.addListener((d) =>
      whenLoaded(() => {
        if (!inTab(d.tabId)) return;
        if (d.frameId === 0) {
          topUrl = d.url;
          enqueue("nav", { ts: d.timeStamp, url: d.url, kind: "commit" });
        } else injectFrame(d.tabId, d.frameId, d.url);
      }),
    );
    chrome.webNavigation.onHistoryStateUpdated.addListener((d) =>
      whenLoaded(() => {
        if (!inTab(d.tabId) || d.frameId !== 0) return;
        topUrl = d.url;
        enqueue("nav", { ts: d.timeStamp, url: d.url, kind: "spa" });
      }),
    );
    chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) =>
      whenLoaded(() => {
        if (!inTab(d.tabId) || d.frameId !== 0 || !/#\//.test(d.url)) return;
        topUrl = d.url;
        enqueue("nav", { ts: d.timeStamp, url: d.url, kind: "spa" });
      }),
    );
    chrome.webNavigation.onCompleted.addListener((d) =>
      whenLoaded(() => {
        if (inTab(d.tabId) && d.frameId === 0) void snapshotCookies(true);
      }),
    );
    chrome.tabs.onRemoved.addListener((tabId) =>
      whenLoaded(() => {
        if (session && session.tabId === tabId) {
          session.tabClosed = true;
          void flush();
        }
      }),
    );
    chrome.runtime.onStartup.addListener(() =>
      whenLoaded(() => {
        // Tab ids do not survive a browser restart, and registered scripts are gone.
        if (session && recording()) {
          session.tabClosed = true;
          void flush();
        }
      }),
    );
    chrome.runtime.onInstalled.addListener(() => {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    });
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

    /* ------------------------------ relay -------------------------------- */

    function onRelay(msg: RelayMessage, sender: chrome.runtime.MessageSender) {
      if (!inTab(sender.tab?.id) || !session) return;
      if (msg.type === "page_click") {
        if (typeof msg.t !== "number") return;
        session.clicks.push(msg.t);
        if (session.clicks.length > MAX_CLICKS) session.clicks.splice(0, session.clicks.length - MAX_CLICKS);
        void snapshotCookies();
        return;
      }
      if (msg.type !== "page_state" || typeof msg.state !== "string" || msg.state.length > 4_000_000) return;
      let st: { t?: number; dl?: Array<{ t: number; p: unknown }>; dropped?: number; ics?: unknown };
      try {
        st = JSON.parse(msg.state);
      } catch {
        return;
      }
      const pageUrl = topUrl || session.target;
      for (const e of Array.isArray(st.dl) ? st.dl : []) {
        if (!e || typeof e.t !== "number") continue;
        enqueue("dl", { t: e.t, p: e.p, pageUrl });
        const choice = consentChoiceFromPush(e.p);
        if (choice) {
          const m = autoMarker({ pushT: e.t, choice, visitor: session.visitor, clicks: session.clicks, startedAt: session.startedAt, current: session.marker });
          if (m) session.marker = m;
        }
      }
      if (typeof st.dropped === "number" && st.dropped > 0) session.droppedPushes += st.dropped;
      if (msg.top && typeof st.t === "number") {
        const s = JSON.stringify(st.ics ?? null);
        if (s !== lastIcs) {
          lastIcs = s;
          enqueue("ics", { t: st.t, ics: st.ics ?? null });
        }
      }
    }

    /* ------------------------------ panel -------------------------------- */

    const fail = (error: string): Reply => ({ ok: false, error });

    async function start(m: Extract<PanelMessage, { type: "start" }>): Promise<Reply> {
      if (recording()) return fail("busy");
      const u = recordableUrl(m.url);
      if (!u || typeof m.tabId !== "number") return fail("bad_tab");
      if (!(await chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] }))) return fail("permission");
      await clearEvents().catch(() => {});
      await clearPrepared().catch(() => {});
      if (m.visitor === "fresh") {
        await chrome.browsingData.remove(
          { origins: [u.origin] },
          { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true },
        );
      }
      const patterns = siteMatchPatterns(u.href);
      await unregisterScripts();
      await chrome.scripting.registerContentScripts([
        { id: "strv-main", js: ["main-world.js"], matches: patterns, runAt: "document_start", world: "MAIN", allFrames: true, persistAcrossSessions: false },
        { id: "strv-relay", js: ["relay.js"], matches: patterns, runAt: "document_start", world: "ISOLATED", allFrames: true, persistAcrossSessions: false },
      ]);
      const template = getTemplate(m.templateId);
      session = {
        id: crypto.randomUUID(),
        tabId: m.tabId,
        target: u.href,
        startedAt: Date.now(),
        visitor: m.visitor === "returning" ? "returning" : "fresh",
        ...(template ? { templateId: template.id } : {}),
        patterns,
        marker: null,
        steps: [],
        clicks: [],
        droppedPushes: 0,
        counts: { requests: 0, tracking: 0, dataLayer: 0 },
        state: "recording",
      };
      topUrl = u.href;
      lastIcs = "";
      queue = [];
      await setSession(session);
      await chrome.tabs.reload(m.tabId, { bypassCache: true });
      return { ok: true, data: { session } };
    }

    async function stop(): Promise<Reply> {
      if (!session) return fail("no_session");
      if (session.state === "review") return review();
      if (session.state !== "recording") return fail("busy");
      session.state = "stopping";
      await flush();
      // Last dataLayer copies from every frame, then a moment for batched beacons to go out.
      if (!session.tabClosed) await chrome.tabs.sendMessage(session.tabId, { type: "flush" }).catch(() => {});
      await sleep(2000);
      await snapshotCookies(true);
      await sleep(150);
      await flush();
      await unregisterScripts();
      const s = session;
      s.stoppedAt = Date.now();
      const events = await readEvents(s.id);
      const env = buildCapture(assemble(s, events, { stoppedAt: s.stoppedAt, userAgent: navigator.userAgent, clientVersion: chrome.runtime.getManifest().version }));
      let prepared;
      try {
        prepared = redactForUpload(env);
      } catch (e) {
        await discard();
        return fail(e instanceof UploadError ? e.code : "invalid_capture");
      }
      await putPrepared(prepared);
      await clearEvents().catch(() => {});
      s.state = "review";
      await setSession(s);
      return { ok: true, data: { summary: summarize(prepared), session: s } };
    }

    async function review(): Promise<Reply> {
      const env = await getPrepared();
      if (!env) return fail("no_session");
      return { ok: true, data: { summary: summarize(env), session } };
    }

    async function upload(): Promise<Reply> {
      if (!session || session.state !== "review") return fail("no_session");
      const env = await getPrepared();
      if (!env) return fail("no_session");
      const api = await apiBase();
      if (!api) return fail("need_key");
      session.state = "uploading";
      await setSession(session);
      try {
        const packed = await packForUpload(env);
        const scan = await uploadCapture(api, packed.gz);
        session.scanId = scan.id;
        session.state = "polling";
        await setSession(session);
        await clearPrepared().catch(() => {});
        await removeRecordingPermissions(api.base);
        return { ok: true, data: { scan, reductions: packed.reductions } };
      } catch (e) {
        session.state = "review";
        await setSession(session);
        if (e instanceof PackError) return fail("payload_too_large");
        return fail(e instanceof ApiError ? e.code : "generic");
      }
    }

    async function discard(): Promise<Reply> {
      await unregisterScripts();
      await clearEvents().catch(() => {});
      await clearPrepared().catch(() => {});
      session = null;
      queue = [];
      await setSession(null);
      const api = await apiBase();
      await removeRecordingPermissions(api?.base ?? DEFAULT_BASE);
      return { ok: true, data: { session: null } };
    }

    async function onPanel(m: PanelMessage): Promise<Reply> {
      await ready;
      switch (m.type) {
        case "status":
          return { ok: true, data: { session } };
        case "start":
          return start(m);
        case "marker": {
          if (!session || session.state !== "recording") return fail("no_session");
          if (m.choice !== "accept" && m.choice !== "reject") return fail("generic");
          session.marker = buttonMarker(Date.now(), m.choice, session.clicks, session.startedAt);
          await flush();
          return { ok: true, data: { session } };
        }
        case "step": {
          if (!session || session.state !== "recording") return fail("no_session");
          const t = getTemplate(session.templateId)?.steps[session.steps.length];
          if (!t) return fail("generic");
          session.steps.push({
            id: t.id,
            name: t.name,
            action: t.action,
            at: t.at,
            ...(t.conversionType ? { conversionType: t.conversionType } : {}),
            status: t.final ? "stopped" : m.status === "skipped" ? "skipped" : "done",
            doneTs: Date.now(),
          });
          await flush();
          return { ok: true, data: { session } };
        }
        case "stop":
          return stop();
        case "review":
          return review();
        case "removeHost": {
          const env = await getPrepared();
          if (!env || typeof m.host !== "string") return fail("no_session");
          const next = removeHost(env, m.host);
          await putPrepared(next);
          return { ok: true, data: { summary: summarize(next), session } };
        }
        case "upload":
          return upload();
        case "polled": {
          if (session && m.finished) {
            session.state = "done";
            if (m.reportUrl) session.reportUrl = m.reportUrl;
            await setSession(session);
          }
          return { ok: true, data: { session } };
        }
        case "discard":
          return discard();
        default:
          return fail("generic");
      }
    }

    chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object") return false;
      const m = msg as { type?: string };
      if ((m.type === "page_state" || m.type === "page_click") && sender.tab) {
        whenLoaded(() => onRelay(msg as RelayMessage, sender));
        return false;
      }
      // Commands only from our own extension pages (the side panel), never from a content script.
      if (typeof sender.url !== "string" || !sender.url.startsWith(chrome.runtime.getURL(""))) return false;
      onPanel(msg as PanelMessage).then(sendResponse, () => sendResponse(fail("generic")));
      return true;
    });
  },
});
