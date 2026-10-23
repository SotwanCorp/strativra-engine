import { DatabaseSync } from "node:sqlite";
import { newId } from "./crypto.ts";

export type JobStatus = "queued" | "running" | "done" | "failed";

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
}

export interface ReportRow {
  id: string;
  token_hash: string;
  kind: string;
  url: string;
  created_at: number;
  expires_at: number;
}

export interface EnqueueInput {
  url: string;
  emailHash: string;
  ipHash: string;
  domain: string;
  emailEnc?: string;
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

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
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
        `INSERT INTO jobs (id,status,url,email_hash,ip_hash,domain,created_at,report_id,email_enc)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, "queued", input.url, input.emailHash, input.ipHash, input.domain, this.now(), reportId, input.emailEnc ?? null);
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

  complete(id: string, report: { tokenHash: string; kind?: string; expiresAt: number }): void {
    const job = this.get(id);
    if (!job) throw new Error("unknown job");
    const t = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO reports (id,token_hash,kind,url,created_at,expires_at) VALUES (?,?,?,?,?,?)")
        .run(job.report_id, report.tokenHash, report.kind ?? "free", job.url, t, report.expiresAt);
      this.db.prepare("UPDATE jobs SET status='done', finished_at=?, email_enc=NULL, error=NULL WHERE id=?").run(t, id);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  fail(id: string, error: string): void {
    this.db
      .prepare("UPDATE jobs SET status='failed', finished_at=?, error=?, email_enc=NULL WHERE id=?")
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
