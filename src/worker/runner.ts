import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newToken, openEmail, sha256Hex } from "./crypto.ts";
import type { Pipeline } from "./pipeline.ts";
import type { Job, JobQueue } from "./queue.ts";
import type { Storage } from "./storage.ts";
import { sendWebhook } from "./webhook.ts";
import type { WebhookPayload } from "./webhook.ts";

export interface RunnerDeps {
  queue: JobQueue;
  storage: Storage;
  pipeline: Pipeline;
  secret: string;
  region: string;
  concurrency: number;
  jobTimeoutMs: number;
  retentionDays: number;
  reportBaseUrl: string;
  webhook: { url?: string; secret: string; fetch?: typeof fetch; backoffMs?: number };
  log?: (msg: string) => void;
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

export class Runner {
  readonly d: RunnerDeps;
  private inflight = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(d: RunnerDeps) {
    this.d = d;
  }

  start(pollMs = 1000) {
    this.timer = setInterval(() => this.tick(), pollMs);
    this.timer.unref?.();
    this.tick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.inflight]);
  }

  /** Claim as many jobs as concurrency allows and start them. */
  tick(): number {
    let started = 0;
    for (;;) {
      const job = this.d.queue.claim(this.d.concurrency);
      if (!job) break;
      const p = this.process(job).catch((e) => this.d.log?.(`runner error: ${(e as Error).message}`)).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
      started++;
    }
    return started;
  }

  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async process(job: Job): Promise<void> {
    const d = this.d;
    const email = openEmail(d.secret, job.email_enc);
    const dir = await mkdtemp(join(tmpdir(), "scan-"));
    let payload: WebhookPayload;
    try {
      const url = await d.pipeline.validateUrl(job.url);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("scan_timeout")), d.jobTimeoutMs); });
      const res = await Promise.race([d.pipeline.run(url, { region: d.region, reportId: job.report_id, screenshotDir: dir }), timeout]).finally(() => clearTimeout(timer));
      await d.storage.putReport(job.report_id, res.html, JSON.stringify(res.report), res.pdf);
      for (const rel of await listFiles(dir)) {
        const ext = rel.split(".").pop()?.toLowerCase() ?? "";
        await d.storage.putAsset(`${job.report_id}/${rel}`, await readFile(join(dir, rel)), MIME[ext]);
      }
      const token = newToken();
      d.queue.complete(job.id, { tokenHash: sha256Hex(token), expiresAt: d.queue.now() + d.retentionDays * 86400_000 });
      payload = { event: "scan.done", jobId: job.id, reportId: job.report_id, url: job.url, email, token, reportUrl: `${d.reportBaseUrl}/r/${token}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "scan_failed";
      d.queue.fail(job.id, msg);
      payload = { event: "scan.failed", jobId: job.id, reportId: job.report_id, url: job.url, email, error: msg.slice(0, 200) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await sendWebhook(payload, { ...d.webhook, log: d.log });
  }
}

/** Flat list of files (screenshots) the pipeline wrote, as safe relative names. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isFile() && /^[A-Za-z0-9._-]+$/.test(ent.name)) out.push(ent.name);
  }
  return out;
}
