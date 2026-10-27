/**
 * Per-scan AI budget + a global daily USD circuit breaker.
 *
 * Every AI call asks the budget first (`allowJev`, `allowClaude`) and records
 * its usage after. When a cap or the breaker trips, callers degrade to the
 * deterministic path (rules, templates). The report says nothing about it.
 */
import type { Tier } from "./types.ts";

export interface BudgetLimits {
  maxJevCalls: number;
  /** Input + output tokens across all Claude calls of this scan. */
  maxClaudeTokens: number;
  maxUsd: number;
}

export const DEFAULT_LIMITS: Record<Tier, BudgetLimits> = {
  free: { maxJevCalls: 4, maxClaudeTokens: 24_000, maxUsd: 0.05 },
  paid: { maxJevCalls: 40, maxClaudeTokens: 600_000, maxUsd: 15 },
};

/**
 * USD per million tokens. From the Claude API model table cached 2026-10-06
 * (re-check before launch). Cache writes are billed at 1.25x input (5 min TTL).
 */
export const CLAUDE_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** Jev pricing is not published yet (to confirm with TypeSafe). Configurable, 0 until known. */
export const JEV_USD_PER_CALL_DEFAULT = 0;

export interface ClaudeUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function claudeCostUsd(model: string, u: ClaudeUsageLike): number {
  const p = CLAUDE_PRICES[model] ?? CLAUDE_PRICES["claude-opus-5-5"];
  const cr = u.cache_read_input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  return (u.input_tokens * p.input + u.output_tokens * p.output + cr * p.cacheRead + cw * p.cacheWrite) / 1_000_000;
}

/** Store for the global daily spend. In-memory by default; the worker can back it with SQLite. */
export interface DailySpendStore {
  get(day: string): number;
  add(day: string, usd: number): void;
}

export class MemorySpendStore implements DailySpendStore {
  #m = new Map<string, number>();
  get(day: string): number {
    return this.#m.get(day) ?? 0;
  }
  add(day: string, usd: number): void {
    this.#m.set(day, this.get(day) + usd);
  }
}

export class DailyBreaker {
  readonly maxUsdPerDay: number;
  readonly store: DailySpendStore;
  readonly now: () => Date;
  constructor(opts: { maxUsdPerDay: number; store?: DailySpendStore; now?: () => Date }) {
    this.maxUsdPerDay = opts.maxUsdPerDay;
    this.store = opts.store ?? new MemorySpendStore();
    this.now = opts.now ?? (() => new Date());
  }
  day(): string {
    return this.now().toISOString().slice(0, 10);
  }
  tripped(): boolean {
    return this.store.get(this.day()) >= this.maxUsdPerDay;
  }
  record(usd: number): void {
    if (usd > 0) this.store.add(this.day(), usd);
  }
}

export interface UsageLog {
  jevCalls: number;
  jevInputTokens: number;
  jevOutputTokens: number;
  claudeCalls: number;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  claudeCacheReadTokens: number;
  claudeCacheWriteTokens: number;
  usd: number;
  /** Calls skipped because a cap or the breaker tripped. Internal only. */
  skipped: number;
  degraded: boolean;
}

export class ScanBudget {
  readonly limits: BudgetLimits;
  readonly breaker?: DailyBreaker;
  readonly jevUsdPerCall: number;
  readonly usage: UsageLog = {
    jevCalls: 0, jevInputTokens: 0, jevOutputTokens: 0,
    claudeCalls: 0, claudeInputTokens: 0, claudeOutputTokens: 0, claudeCacheReadTokens: 0, claudeCacheWriteTokens: 0,
    usd: 0, skipped: 0, degraded: false,
  };

  constructor(opts: { tier: Tier; limits?: Partial<BudgetLimits>; breaker?: DailyBreaker; jevUsdPerCall?: number }) {
    this.limits = { ...DEFAULT_LIMITS[opts.tier], ...opts.limits };
    this.breaker = opts.breaker;
    this.jevUsdPerCall = opts.jevUsdPerCall ?? JEV_USD_PER_CALL_DEFAULT;
  }

  #deny(): false {
    this.usage.skipped++;
    this.usage.degraded = true;
    return false;
  }

  #open(): boolean {
    return !(this.breaker?.tripped() ?? false) && this.usage.usd < this.limits.maxUsd;
  }

  allowJev(): boolean {
    if (!this.#open() || this.usage.jevCalls >= this.limits.maxJevCalls) return this.#deny();
    return true;
  }

  /** `maxTokens` is the request's max_tokens; the estimate of input tokens is added by the caller. */
  allowClaude(estimatedTokens: number): boolean {
    const used = this.usage.claudeInputTokens + this.usage.claudeOutputTokens + this.usage.claudeCacheReadTokens + this.usage.claudeCacheWriteTokens;
    if (!this.#open() || used + estimatedTokens > this.limits.maxClaudeTokens) return this.#deny();
    return true;
  }

  recordJev(u?: { input_tokens: number | null; output_tokens: number | null }): void {
    this.usage.jevCalls++;
    this.usage.jevInputTokens += u?.input_tokens ?? 0;
    this.usage.jevOutputTokens += u?.output_tokens ?? 0;
    this.#spend(this.jevUsdPerCall);
  }

  recordClaude(model: string, u: ClaudeUsageLike): void {
    this.usage.claudeCalls++;
    this.usage.claudeInputTokens += u.input_tokens;
    this.usage.claudeOutputTokens += u.output_tokens;
    this.usage.claudeCacheReadTokens += u.cache_read_input_tokens ?? 0;
    this.usage.claudeCacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    this.#spend(claudeCostUsd(model, u));
  }

  #spend(usd: number): void {
    this.usage.usd += usd;
    this.breaker?.record(usd);
  }
}

/** Rough token estimate for budgeting before a call (4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
