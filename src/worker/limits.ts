import type { DatabaseSync } from "node:sqlite";

export interface LimitConfig {
  ipPerHour: number;
  emailPerDay: number;
  domainPerDay: number;
  maxQueueDepth: number;
}

export const DEFAULT_LIMITS: LimitConfig = { ipPerHour: 5, emailPerDay: 3, domainPerDay: 3, maxQueueDepth: 50 };

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export type LimitResult = { ok: true } | { ok: false; scope: "ip" | "email" | "domain" | "queue"; retryAfterSec: number };

/** Sliding-window limits kept in SQLite so they survive restarts. Keys are HMAC hashes. */
export class Limits {
  readonly db: DatabaseSync;
  readonly cfg: LimitConfig;
  readonly now: () => number;

  constructor(db: DatabaseSync, cfg: Partial<LimitConfig> = {}, now: () => number = Date.now) {
    this.db = db;
    this.cfg = { ...DEFAULT_LIMITS, ...cfg };
    this.now = now;
  }

  private window(scope: string, key: string, windowMs: number, max: number): number {
    const since = this.now() - windowMs;
    const rows = this.db
      .prepare("SELECT ts FROM hits WHERE scope=? AND key_hash=? AND ts > ? ORDER BY ts ASC")
      .all(scope, key, since) as { ts: number }[];
    if (rows.length < max) return 0;
    // Free again when the hit that puts us at the cap ages out.
    const pivot = rows[rows.length - max].ts;
    return Math.max(1, Math.ceil((pivot + windowMs - this.now()) / 1000));
  }

  /** Read-only check. */
  check(h: { ipHash: string; emailHash: string; domainHash: string }, queueDepth: number): LimitResult {
    if (queueDepth >= this.cfg.maxQueueDepth) return { ok: false, scope: "queue", retryAfterSec: 60 };
    let r = this.window("ip", h.ipHash, HOUR, this.cfg.ipPerHour);
    if (r) return { ok: false, scope: "ip", retryAfterSec: r };
    r = this.window("email", h.emailHash, DAY, this.cfg.emailPerDay);
    if (r) return { ok: false, scope: "email", retryAfterSec: r };
    r = this.window("domain", h.domainHash, DAY, this.cfg.domainPerDay);
    if (r) return { ok: false, scope: "domain", retryAfterSec: r };
    return { ok: true };
  }

  record(h: { ipHash: string; emailHash: string; domainHash: string }): void {
    const t = this.now();
    const ins = this.db.prepare("INSERT INTO hits (scope,key_hash,ts) VALUES (?,?,?)");
    ins.run("ip", h.ipHash, t);
    ins.run("email", h.emailHash, t);
    ins.run("domain", h.domainHash, t);
  }

  prune(): void {
    this.db.prepare("DELETE FROM hits WHERE ts <= ?").run(this.now() - DAY - HOUR);
  }
}
