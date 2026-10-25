/**
 * Side panel UI. Vanilla DOM, text only through textContent. One screen at a time, one main action
 * per screen. Talks to the service worker for Mode B and to the API directly for Mode A and polling.
 */
import { createScan, DEFAULT_BASE, normalizeBaseUrl, pollScan, scanState, type ApiError, type ScanObject } from "../../lib/api.ts";
import { checkApiKey } from "../../lib/key.ts";
import type { PanelMessage, Reply, ReviewData, StatusData, UploadData } from "../../lib/messages.ts";
import type { ReviewSummary } from "../../lib/prepare.ts";
import { basePattern, RECORDING_ORIGINS, recordableUrl, type Visitor } from "../../lib/record.ts";
import { getSettings, MODE_A_KEY, setSettings, type Session, type Settings } from "../../lib/store.ts";
import { errorText, S } from "../../lib/strings.ts";
import { getTemplate } from "../../lib/templates.ts";

type View = "loading" | "settings" | "home" | "scan" | "setup" | "confirm" | "recording" | "review" | "sending" | "done";

const ui: {
  view: View;
  settings: Settings | null;
  session: Session | null;
  summary: ReviewSummary | null;
  scan: ScanObject | null;
  scanMode: "a" | "b";
  visitor: Visitor;
  templateId: "lead" | "ecommerce" | "";
  target: { tabId: number; url: string } | null;
  prefillUrl: string;
  savedNote: boolean;
} = {
  view: "loading",
  settings: null,
  session: null,
  summary: null,
  scan: null,
  scanMode: "a",
  visitor: "fresh",
  templateId: "",
  target: null,
  prefillUrl: "",
  savedNote: false,
};

const app = document.getElementById("app") as HTMLElement;
const errorBox = document.getElementById("error") as HTMLElement;
const fixedTabId = Number(new URLSearchParams(location.search).get("tabId")) || undefined;
let statusTimer: ReturnType<typeof setInterval> | undefined;
let pollAbort: AbortController | undefined;

/* ------------------------------ helpers ------------------------------ */

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

const btn = (id: string, label: string, onclick: (e: Event) => void, cls = "btn") => h("button", { id, type: "button", class: cls, onclick }, label);

function showError(code: string | null) {
  errorBox.hidden = !code;
  errorBox.textContent = code ? (code in S.errors ? errorText(code) : code) : "";
}

async function send<T>(m: PanelMessage): Promise<Reply<T>> {
  try {
    return ((await chrome.runtime.sendMessage(m)) as Reply<T>) ?? { ok: false, error: "generic" };
  } catch {
    return { ok: false, error: "generic" };
  }
}

function go(view: View) {
  ui.view = view;
  render();
}

async function targetTab(): Promise<{ tabId: number; url: string | undefined } | null> {
  try {
    if (fixedTabId) {
      const t = await chrome.tabs.get(fixedTabId);
      return { tabId: fixedTabId, url: t.url };
    }
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t?.id !== undefined ? { tabId: t.id, url: t.url } : null;
  } catch {
    return null;
  }
}

function apiOpts(): { base: string; key: string } | null {
  const s = ui.settings;
  if (!s?.key) return null;
  return { base: normalizeBaseUrl(s.base) ?? DEFAULT_BASE, key: s.key };
}

function auditUrl(): string {
  return `${apiOpts()?.base ?? DEFAULT_BASE}/audit`;
}

function openTab(url: string) {
  chrome.tabs.create({ url }).catch(() => {});
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

/* ------------------------------ screens ------------------------------ */

function settingsView(): Child[] {
  const key = h("input", { id: "key", type: "password", autocomplete: "off", spellcheck: "false", value: ui.settings?.key ?? "" });
  const base = h("input", { id: "base", type: "text", autocomplete: "off", spellcheck: "false", value: ui.settings?.base ?? DEFAULT_BASE });
  const save = () => {
    const k = key.value.trim();
    const check = checkApiKey(k);
    if (check !== "ok") return showError(S.keyErrors[check]);
    const b = normalizeBaseUrl(base.value);
    if (!b) return showError(S.baseError);
    // Called inside the click: a server other than strativra.com needs its own host permission.
    const perm = b === DEFAULT_BASE ? Promise.resolve(true) : chrome.permissions.request({ origins: [basePattern(b)] });
    perm.then(async (granted) => {
      if (!granted) return showError(S.baseError);
      ui.settings = { key: k, base: b };
      await setSettings(ui.settings);
      showError(null);
      ui.savedNote = true;
      go("home");
    });
  };
  return [
    h("h1", {}, S.settings),
    h("label", { class: "field" }, h("span", { class: "label" }, S.keyLabel), key, h("span", { class: "help" }, S.keyHelp)),
    h("a", { class: "link", href: `${DEFAULT_BASE}/account`, target: "_blank", rel: "noreferrer" }, S.keyLink),
    h("label", { class: "field" }, h("span", { class: "label" }, S.baseLabel), base, h("span", { class: "help" }, S.baseHelp)),
    btn("save", S.save, save, "btn primary"),
    ui.settings?.key ? btn("settings-back", S.back, () => go("home"), "btn ghost") : null,
  ];
}

function homeView(): Child[] {
  const url = h("input", { id: "url", type: "text", placeholder: S.urlPlaceholder, autocomplete: "off", spellcheck: "false", value: ui.prefillUrl });
  const scanA = () => {
    const raw = url.value.trim();
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!raw || !recordableUrl(withScheme)) return showError("invalid_url");
    void startModeA(withScheme);
  };
  return [
    ui.savedNote ? h("p", { class: "help", id: "saved" }, S.saved) : null,
    h("h1", {}, S.homeTitle),
    h(
      "section",
      { class: "block" },
      h("h2", {}, S.modeA),
      h("p", { class: "help" }, S.modeAHelp),
      h("label", { class: "field" }, h("span", { class: "label" }, S.urlLabel), url),
      btn("scan-a", S.modeA, scanA, "btn primary"),
    ),
    h(
      "section",
      { class: "block" },
      h("h2", {}, S.modeB),
      h("p", { class: "help" }, S.modeBHelp),
      btn("record-b", S.modeB, () => go("setup")),
    ),
  ];
}

function scanView(): Child[] {
  const s = ui.scan;
  const st = s ? scanState(s) : null;
  const out: Child[] = [h("h1", {}, st?.ok ? S.reportReady : st?.finished ? S.scanFailed : s?.status === "queued" ? S.queued : S.running)];
  if (s && !st?.finished && typeof s.position === "number" && s.position > 0) out.push(h("p", { class: "mono", id: "position" }, S.position(s.position)));
  if (s && !st?.finished) out.push(h("div", { class: "rec" }, h("i", {}), ui.scanMode === "a" ? S.running : S.building));
  if (st?.botProtection) {
    out.push(h("p", { id: "bot-wall" }, S.botWall), btn("record-b", S.modeB, () => go("setup"), "btn primary"));
  }
  if (st?.reportUrl) {
    const url = st.reportUrl;
    out.push(btn("open-report", S.openReport, () => openTab(url), st.botProtection ? "btn" : "btn primary"));
    out.push(h("a", { class: "btn ghost", id: "audit", href: auditUrl(), target: "_blank", rel: "noreferrer" }, S.audit));
  }
  if (st?.finished) out.push(btn("new-check", S.back, () => void reset(), "link"));
  return out;
}

function setupView(): Child[] {
  const radio = (name: string, value: string, checked: boolean, label: string, help: string, onchange: () => void) =>
    h("label", { class: "choice" }, h("input", { type: "radio", name, value, id: `${name}-${value || "none"}`, checked, onchange }), h("span", {}, label), h("small", {}, help));
  const start = () => {
    // Must run inside the click: Chrome only shows the permission prompt for a user gesture.
    chrome.permissions.request({ origins: RECORDING_ORIGINS }).then(async (granted) => {
      if (!granted) return showError(S.permDenied);
      const t = await targetTab();
      if (!t || !recordableUrl(t.url)) return showError(S.badTab);
      ui.target = { tabId: t.tabId, url: t.url! };
      showError(null);
      if (ui.visitor === "fresh") go("confirm");
      else void startRecording();
    });
  };
  return [
    h("h1", {}, S.modeB),
    h(
      "fieldset",
      { class: "choices" },
      h("legend", { class: "label" }, S.visitorTitle),
      radio("visitor", "fresh", ui.visitor === "fresh", S.fresh, S.freshHelp, () => (ui.visitor = "fresh")),
      radio("visitor", "returning", ui.visitor === "returning", S.returning, S.returningHelp, () => (ui.visitor = "returning")),
    ),
    h(
      "fieldset",
      { class: "choices" },
      h("legend", { class: "label" }, S.pathTitle),
      radio("path", "", ui.templateId === "", S.pathNone, "", () => (ui.templateId = "")),
      radio("path", "lead", ui.templateId === "lead", S.pathLead, "", () => (ui.templateId = "lead")),
      radio("path", "ecommerce", ui.templateId === "ecommerce", S.pathShop, "", () => (ui.templateId = "ecommerce")),
    ),
    btn("start", S.start, start, "btn primary"),
    btn("setup-back", S.back, () => go("home"), "link"),
  ];
}

function confirmView(): Child[] {
  const host = ui.target ? hostOf(ui.target.url) : "";
  return [
    h("h1", {}, S.confirmTitle(host)),
    h("p", {}, S.confirmBody),
    btn("confirm-yes", S.confirmYes, () => void startRecording(), "btn primary"),
    btn("confirm-cancel", S.cancel, () => go("setup"), "btn ghost"),
  ];
}

function elapsed(from: number): string {
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function recordingView(): Child[] {
  const s = ui.session;
  if (!s) return [h("p", {}, S.rec)];
  const stopping = s.state === "stopping";
  const t = getTemplate(s.templateId);
  const marker = s.marker;
  const out: Child[] = [
    h("div", { class: "band" }, h("div", { class: "rec" }, h("i", {}), `${S.rec} `, h("span", { id: "elapsed" }, elapsed(s.startedAt))), h("span", { class: "mono" }, hostOf(s.target))),
    h(
      "div",
      { class: "counts", id: "counts" },
      h("div", {}, h("b", { id: "count-requests" }, String(s.counts.requests)), h("span", { class: "label" }, S.countRequests)),
      h("div", {}, h("b", { id: "count-tracking" }, String(s.counts.tracking)), h("span", { class: "label" }, S.countTracking)),
      h("div", {}, h("b", { id: "count-datalayer" }, String(s.counts.dataLayer)), h("span", { class: "label" }, S.countDataLayer)),
    ),
    s.tabClosed ? h("p", { id: "tab-closed" }, S.tabClosed) : null,
    h(
      "section",
      { class: "block" },
      h("h2", {}, S.consentTitle),
      h("p", { class: "mono", id: "consent-state" }, marker ? S.consentSeen(marker.choice, marker.source) : S.consentNone),
      h(
        "div",
        { class: "row" },
        btn("mark-accept", S.clickedAccept, () => void act({ type: "marker", choice: "accept" }), "btn ghost"),
        btn("mark-reject", S.clickedReject, () => void act({ type: "marker", choice: "reject" }), "btn ghost"),
      ),
    ),
  ];
  if (t) {
    const n = s.steps.length;
    out.push(
      h(
        "section",
        { class: "block" },
        h("h2", {}, S.stepsTitle),
        h(
          "ol",
          { class: "steps", id: "steps" },
          ...t.steps.map((st, i) => {
            const rec = s.steps[i];
            const cls = rec ? (rec.status === "skipped" ? "skipped" : "done") : i === n ? "current" : "";
            return h(
              "li",
              { class: cls },
              h("span", {}, st.label),
              i === n && !stopping
                ? h(
                    "div",
                    { class: st.final ? "" : "row" },
                    btn("step-done", S.stepDone, () => void act({ type: "step", status: "done" }), "btn"),
                    st.final ? null : btn("step-skip", S.stepSkip, () => void act({ type: "step", status: "skipped" }), "btn ghost"),
                  )
                : null,
            );
          }),
        ),
        n >= t.steps.length ? h("p", { class: "help" }, S.stepsFinished) : null,
      ),
    );
  }
  out.push(btn("stop", S.stop, () => void stopRecording(), "btn primary"));
  if (stopping) (out[out.length - 1] as HTMLButtonElement).disabled = true;
  return out;
}

function reviewView(): Child[] {
  const sum = ui.summary;
  if (!sum) return [h("p", {}, S.reviewTitle)];
  const c = (id: string, n: number, label: string) => h("div", {}, h("b", { id }, String(n)), h("span", { class: "label" }, label));
  return [
    h("h1", {}, S.reviewTitle),
    h("p", { class: "mono", id: "review-labels" }, `${S.scenarioLabel[sum.scenario]}. ${ui.session ? S.visitorLabel[ui.session.visitor] : ""}.`),
    h(
      "div",
      { class: "counts five" },
      c("review-requests", sum.requests, S.countRequests),
      c("review-tracking", sum.tracking, S.countTracking),
      c("review-datalayer", sum.dataLayer, S.countDataLayer),
      c("review-cookies", sum.cookies, S.countCookies),
      c("review-pages", sum.pages, S.countPages),
    ),
    h("p", { class: "help" }, S.reviewHelp),
    h("h2", {}, S.hostsTitle),
    h(
      "ul",
      { class: "hosts", id: "hosts" },
      ...sum.hosts.map((row) =>
        h(
          "li",
          { "data-host": row.host },
          h("span", { class: "mono" }, row.host),
          h("button", { type: "button", "data-remove": row.host, onclick: () => void act({ type: "removeHost", host: row.host }) }, S.remove),
          h("span", { class: "tag" }, [String(row.requests), row.firstParty ? S.thisSite : "", ...row.vendors].filter(Boolean).join(" / ")),
        ),
      ),
    ),
    btn("upload", S.upload, () => void uploadRecording(), "btn primary"),
    btn("discard", S.discard, () => void reset(), "btn ghost"),
  ];
}

function sendingView(): Child[] {
  return [h("h1", {}, S.uploading), h("div", { class: "rec" }, h("i", {}), S.uploading)];
}

function render() {
  const views: Record<View, () => Child[]> = {
    loading: () => [],
    settings: settingsView,
    home: homeView,
    scan: scanView,
    setup: setupView,
    confirm: confirmView,
    recording: recordingView,
    review: reviewView,
    sending: sendingView,
    done: scanView,
  };
  app.replaceChildren(...views[ui.view]().filter((x): x is Node | string => !!x));
  document.body.dataset.view = ui.view;
  if (ui.view === "recording") {
    statusTimer ??= setInterval(() => void refreshStatus(), 1000);
  } else if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = undefined;
  }
}

/* ------------------------------ actions ------------------------------ */

async function act(m: PanelMessage) {
  const r = await send<StatusData & Partial<ReviewData>>(m);
  if (!r.ok) return showError(r.error ?? "generic");
  showError(null);
  if (r.data?.session !== undefined) ui.session = r.data.session;
  if (r.data?.summary) ui.summary = r.data.summary;
  render();
}

async function refreshStatus() {
  const r = await send<StatusData>({ type: "status" });
  if (!r.ok || !r.data) return;
  ui.session = r.data.session;
  if (ui.view === "recording") render();
}

async function startRecording() {
  const t = ui.target;
  if (!t) return showError(S.badTab);
  const r = await send<StatusData>({ type: "start", tabId: t.tabId, url: t.url, visitor: ui.visitor, ...(ui.templateId ? { templateId: ui.templateId } : {}) });
  if (!r.ok) return showError(r.error === "bad_tab" ? S.badTab : r.error === "permission" ? S.permDenied : r.error ?? "generic");
  showError(null);
  ui.session = r.data?.session ?? null;
  go("recording");
}

async function stopRecording() {
  if (ui.session) ui.session.state = "stopping";
  render();
  const r = await send<ReviewData>({ type: "stop" });
  if (!r.ok || !r.data) {
    showError(r.error ?? "generic");
    return void boot();
  }
  ui.summary = r.data.summary;
  ui.session = r.data.session;
  go("review");
}

async function uploadRecording() {
  if (!apiOpts()) {
    showError(S.needKey);
    return go("settings");
  }
  go("sending");
  const r = await send<UploadData>({ type: "upload" });
  if (!r.ok || !r.data) {
    showError(r.error === "need_key" ? S.needKey : r.error ?? "generic");
    return go("review");
  }
  showError(null);
  ui.scanMode = "b";
  void followScan(r.data.scan);
}

async function startModeA(url: string) {
  const api = apiOpts();
  if (!api) {
    showError(S.needKey);
    return go("settings");
  }
  try {
    const scan = await createScan(api, url);
    showError(null);
    ui.scanMode = "a";
    await chrome.storage.local.set({ [MODE_A_KEY]: { id: scan.id } });
    void followScan(scan);
  } catch (e) {
    showError((e as ApiError).code ?? "generic");
  }
}

async function followScan(scan: ScanObject) {
  const api = apiOpts();
  ui.scan = scan;
  go("scan");
  if (!api) return;
  pollAbort?.abort();
  pollAbort = new AbortController();
  try {
    const final = await pollScan(api, scan.id, {
      signal: pollAbort.signal,
      onUpdate: (s) => {
        ui.scan = s;
        if (ui.view === "scan") render();
      },
    });
    ui.scan = final;
    const st = scanState(final);
    if (ui.scanMode === "b") await send({ type: "polled", finished: true, ...(st.reportUrl ? { reportUrl: st.reportUrl } : {}) });
    else await chrome.storage.local.remove(MODE_A_KEY);
    if (st.reportUrl) openTab(st.reportUrl);
    go("done");
  } catch (e) {
    const code = (e as ApiError).code;
    if (code !== "aborted") showError(code ?? "generic");
  }
}

async function reset() {
  pollAbort?.abort();
  await chrome.storage.local.remove(MODE_A_KEY);
  await send({ type: "discard" });
  ui.session = null;
  ui.summary = null;
  ui.scan = null;
  showError(null);
  go(ui.settings?.key ? "home" : "settings");
}

/* -------------------------------- boot -------------------------------- */

async function boot() {
  ui.settings = await getSettings();
  const t = await targetTab();
  if (t?.url && recordableUrl(t.url)) ui.prefillUrl = t.url;
  const r = await send<StatusData>({ type: "status" });
  const s = r.data?.session ?? null;
  ui.session = s;
  if (s && (s.state === "recording" || s.state === "stopping")) return go("recording");
  if (s && s.state === "review") {
    const rv = await send<ReviewData>({ type: "review" });
    if (rv.ok && rv.data) {
      ui.summary = rv.data.summary;
      return go("review");
    }
  }
  if (s && s.state === "uploading") return go("review");
  if (s && s.state === "done" && s.scanId) {
    ui.scanMode = "b";
    ui.scan = { id: s.scanId, status: "done", ...(s.reportUrl ? { report_url: s.reportUrl } : {}) };
    return go("done");
  }
  if (s && s.state === "polling" && s.scanId) {
    ui.scanMode = "b";
    return void followScan({ id: s.scanId, status: "running" });
  }
  const a = (await chrome.storage.local.get(MODE_A_KEY))[MODE_A_KEY] as { id?: string } | undefined;
  if (a?.id && ui.settings?.key) {
    ui.scanMode = "a";
    return void followScan({ id: a.id, status: "running" });
  }
  go(ui.settings?.key ? "home" : "settings");
}

document.getElementById("nav-settings")?.addEventListener("click", () => {
  showError(null);
  go("settings");
});
void boot();
