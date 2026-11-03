import { DatabaseSync } from "node:sqlite";
import { newId } from "./crypto.ts";

export type JobStatus = "queued" | "running" | "done" | "failed";

/** Where a job came from (CONNECTORS.md section 1). Hosted scans of the public form are "website". */
export const SOURCES = ["website", "account", "api", "wordpress", "extension"] as const;
export type Source = (typeof SOURCES)[number];
export const TRIGGERS = ["manual", "change_event", "schedule", "upload"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export type JobKind = "scan" | "capture";

export interface Job {
  id: string;
  status: JobStatus;
  url: string;
  email_hash: string;
  ip_hash: string;
  domain: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  report_id: string;
  attempts: number;
  /** Transient encrypted email, nulled when the job finishes. */
  email_enc: string | null;
  /** "scan" browses the site; "capture" builds the report from an uploaded recording. */
  kind: JobKind;
  source: Source;
  trigger_kind: Trigger;
  account_ref: string | null;
  site_ref: string | null;
  /** 0 skips AI enrichment. */
  ai: number;
  /** Capture jobs: gzipped JSON of the validated upload, nulled when the job finishes. */
  input_gz: Uint8Array | null;
}

export interface ReportRow {
  id: string;
  token_hash: string;
  kind: string;
  url: string;
  created_at: number;
  expires_at: number;
  /** JSON array of asset file names stored under assets/<report id>/, so erasure can remove them from R2. */
  assets: string | null;
}

export interface EnqueueInput {
  url: string;
  emailHash: string;
  ipHash: string;
  domain: string;
  emailEnc?: string;
  kind?: JobKind;
  source?: Source;
  trigger?: Trigger;
  accountRef?: string;
  siteRef?: string;
  /** Default true. */
  ai?: boolean;
  input?: Uint8Array;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  url TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  report_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  email_enc TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hits (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hits_lookup ON hits(scope, key_hash, ts);
`;

export const MAX_ATTEMPTS = 2;
export const STALE_RUNNING_MS = 10 * 60 * 1000;

/** Columns added after the first release. Each is added once; running this again changes nothing. */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "jobs", column: "kind", ddl: "TEXT NOT NULL DEFAULT 'scan'" },
  { table: "jobs", column: "source", ddl: "TEXT NOT NULL DEFAULT 'website'" },
  { table: "jobs", column: "trigger_kind", ddl: "TEXT NOT NULL DEFAULT 'manual'" },
  { table: "jobs", column: "account_ref", ddl: "TEXT" },
  { table: "jobs", column: "site_ref", ddl: "TEXT" },
  { table: "jobs", column: "ai", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "jobs", column: "input_gz", ddl: "BLOB" },
  { table: "reports", column: "assets", ddl: "TEXT" },
];

export function migrate(db: DatabaseSync): void {
  for (const m of MIGRATIONS) {
    const have = (db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[]).some((c) => c.name === m.column);
    if (have) continue;
    try {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
    } catch (e) {
      // Another process added it between the check and the ALTER.
      if (!/duplicate column/i.test((e as Error).message)) throw e;
    }
  }
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export class JobQueue {
  readonly db: DatabaseSync;
  readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  enqueue(input: EnqueueInput): { id: string; reportId: string } {
    const id = newId();
    const reportId = newId();
    this.db
      .prepare(
        `INSERT INTO jobs (id,status,url,email_hash,ip_hash,domain,created_at,report_id,email_enc,kind,source,trigger_kind,account_ref,site_ref,ai,input_gz)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, "queued", input.url, input.emailHash, input.ipHash, input.domain, this.now(), reportId, input.emailEnc ?? null,
        input.kind ?? "scan", input.source ?? "website", input.trigger ?? "manual", input.accountRef ?? null, input.siteRef ?? null,
        input.ai === false ? 0 : 1, input.input ?? null,
      );
    return { id, reportId };
  }

  /** Atomically claim the oldest queued job, unless `maxRunning` jobs already run. */
  claim(maxRunning = 2): Job | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const running = (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='running'").get() as { n: number }).n;
      if (running >= maxRunning) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const job = this.db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1").get() as unknown as Job | undefined;
      if (!job) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const t = this.now();
      this.db.prepare("UPDATE jobs SET status='running', started_at=?, attempts=attempts+1 WHERE id=?").run(t, job.id);
      this.db.exec("COMMIT");
      return { ...job, status: "running", started_at: t, attempts: job.attempts + 1 };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already closed */ }
      throw e;
    }
  }

  complete(id: string, report: { tokenHash: string; kind?: string; expiresAt: number; assets?: string[] }): void {
    const job = this.get(id);
    if (!job) throw new Error("unknown job");
    const t = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO reports (id,token_hash,kind,url,created_at,expires_at,assets) VALUES (?,?,?,?,?,?,?)")
        .run(job.report_id, report.tokenHash, report.kind ?? "free", job.url, t, report.expiresAt, report.assets?.length ? JSON.stringify(report.assets) : null);
      this.db.prepare("UPDATE jobs SET status='done', finished_at=?, email_enc=NULL, input_gz=NULL, error=NULL WHERE id=?").run(t, id);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  fail(id: string, error: string): void {
    this.db
      .prepare("UPDATE jobs SET status='failed', finished_at=?, error=?, email_enc=NULL, input_gz=NULL WHERE id=?")
      .run(this.now(), error.slice(0, 300), id);
  }

  get(id: string): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as Job | undefined;
  }

  /** Jobs ahead of this one in the queue (0 when it is next or not queued). */
  position(job: Job): number {
    if (job.status !== "queued") return 0;
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='queued' AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM jobs WHERE id=?)))").get(job.created_at, job.created_at, job.id) as { n: number }).n;
  }

  depth(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as { n: number }).n;
  }

  /**
   * Crash recovery. Running jobs started more than `olderThanMs` ago go back to queued
   * once (attempts < MAX_ATTEMPTS), otherwise they fail. Returns [requeued, failed].
   */
  recover(olderThanMs = STALE_RUNNING_MS): [number, number] {
    const cutoff = this.now() - olderThanMs;
    const requeued = this.db
      .prepare("UPDATE jobs SET status='queued', started_at=NULL WHERE status='running' AND started_at <= ? AND attempts < ?")
      .run(cutoff, MAX_ATTEMPTS).changes as number;
    const rows = this.db.prepare("SELECT id FROM jobs WHERE status='running' AND started_at <= ?").all(cutoff) as { id: string }[];
    for (const r of rows) this.fail(r.id, "worker_crashed");
    return [Number(requeued), rows.length];
  }

  reportByTokenHash(tokenHash: string): ReportRow | undefined {
    return this.db.prepare("SELECT * FROM reports WHERE token_hash=?").get(tokenHash) as unknown as ReportRow | undefined;
  }

  reportById(id: string): ReportRow | undefined {
    return this.db.prepare("SELECT * FROM reports WHERE id=?").get(id) as unknown as ReportRow | undefined;
  }

  /** Asset file names recorded for a finished report (empty when none or unknown). */
  reportAssets(id: string): string[] {
    const raw = this.reportById(id)?.assets;
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * Erasure: remove the report row and the job that made it (its URL, hashes and any uploaded input),
   * whatever its status. A running job whose row is gone discards its result when it finishes.
   * Returns how many rows were removed; 0 when there was nothing, which is fine.
   */
  eraseReport(reportId: string): number {
    this.db.exec("BEGIN");
    try {
      const a = this.db.prepare("DELETE FROM reports WHERE id=?").run(reportId).changes as number;
      const b = this.db.prepare("DELETE FROM jobs WHERE report_id=?").run(reportId).changes as number;
      this.db.exec("COMMIT");
      return Number(a) + Number(b);
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  /** Delete expired report rows and old finished jobs. Returns the report ids removed. */
  purgeExpired(retentionMs: number): string[] {
    const t = this.now();
    const ids = (this.db.prepare("SELECT id FROM reports WHERE expires_at <= ?").all(t) as { id: string }[]).map((r) => r.id);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM reports WHERE expires_at <= ?").run(t);
      this.db.prepare("DELETE FROM jobs WHERE status IN ('done','failed') AND finished_at <= ?").run(t - retentionMs);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
    return ids;
  }
}
