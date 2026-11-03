/**
 * Persistence for the service worker, which Chrome stops when idle:
 *  - session meta and settings in chrome.storage.local (small)
 *  - recording batches and the prepared upload in IndexedDB (can be megabytes)
 * Raw batches are deleted as soon as the upload is prepared (redacted); the prepared upload is
 * deleted after a successful upload or a discard.
 */
import type { UploadEnvelope } from "./build.ts";
import type { Marker, StepRecord, Visitor } from "./record.ts";

export interface Settings {
  key: string;
  base: string;
}

export interface Session {
  id: string;
  tabId: number;
  target: string;
  startedAt: number;
  visitor: Visitor;
  templateId?: "lead" | "ecommerce";
  patterns: string[];
  marker: Marker | null;
  steps: StepRecord[];
  clicks: number[];
  droppedPushes: number;
  counts: { requests: number; tracking: number; dataLayer: number };
  state: "recording" | "stopping" | "review" | "uploading" | "polling" | "done";
  tabClosed?: boolean;
  stoppedAt?: number;
  scanId?: string;
  reportUrl?: string;
}

export const SETTINGS_KEY = "strv.settings";
export const SESSION_KEY = "strv.session";
export const MODE_A_KEY = "strv.modeA";

export async function getSettings(): Promise<Settings | null> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] as Settings | undefined;
  return s && typeof s.key === "string" ? s : null;
}

export async function setSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

export async function getSession(): Promise<Session | null> {
  const r = await chrome.storage.local.get(SESSION_KEY);
  return (r[SESSION_KEY] as Session | undefined) ?? null;
}

export async function setSession(s: Session | null): Promise<void> {
  if (s) await chrome.storage.local.set({ [SESSION_KEY]: s });
  else await chrome.storage.local.remove(SESSION_KEY);
}

/* ------------------------------ IndexedDB ------------------------------ */

const DB_NAME = "strativra";
const DB_VERSION = 1;
const EVENTS = "events";
const PREPARED = "prepared";

export interface StoredEvent {
  s: string;
  k: string;
  d: unknown;
}

let dbp: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(EVENTS)) d.createObjectStore(EVENTS, { autoIncrement: true }).createIndex("s", "s");
      if (!d.objectStoreNames.contains(PREPARED)) d.createObjectStore(PREPARED);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbp = undefined;
      reject(req.error);
    };
  });
  return dbp;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function appendEvents(sessionId: string, batch: Array<{ k: string; d: unknown }>): Promise<void> {
  if (!batch.length) return;
  const tx = (await db()).transaction(EVENTS, "readwrite");
  const st = tx.objectStore(EVENTS);
  for (const e of batch) st.add({ s: sessionId, k: e.k, d: e.d } satisfies StoredEvent);
  await done(tx);
}

export async function readEvents(sessionId: string): Promise<StoredEvent[]> {
  const tx = (await db()).transaction(EVENTS, "readonly");
  const req = tx.objectStore(EVENTS).index("s").getAll(IDBKeyRange.only(sessionId));
  const out = await new Promise<StoredEvent[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as StoredEvent[]);
    req.onerror = () => reject(req.error);
  });
  await done(tx);
  return out;
}

export async function clearEvents(): Promise<void> {
  const tx = (await db()).transaction(EVENTS, "readwrite");
  tx.objectStore(EVENTS).clear();
  await done(tx);
}

export async function putPrepared(env: UploadEnvelope): Promise<void> {
  const tx = (await db()).transaction(PREPARED, "readwrite");
  tx.objectStore(PREPARED).put(env, "current");
  await done(tx);
}

export async function getPrepared(): Promise<UploadEnvelope | null> {
  const tx = (await db()).transaction(PREPARED, "readonly");
  const req = tx.objectStore(PREPARED).get("current");
  const out = await new Promise<UploadEnvelope | null>((resolve, reject) => {
    req.onsuccess = () => resolve((req.result as UploadEnvelope | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  await done(tx);
  return out;
}

export async function clearPrepared(): Promise<void> {
  const tx = (await db()).transaction(PREPARED, "readwrite");
  tx.objectStore(PREPARED).clear();
  await done(tx);
}
