import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { runCleanup } from "./cleanup.ts";
import { Limits } from "./limits.ts";
import type { Pipeline } from "./pipeline.ts";
import { JobQueue, openDb } from "./queue.ts";
import { Runner } from "./runner.ts";
import { createWorkerServer } from "./server.ts";
import { LocalStorage, S3Storage } from "./storage.ts";
import type { Storage } from "./storage.ts";
import { verifyTurnstile } from "./turnstile.ts";

// Log lines never contain emails, IPs or tokens.
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function loadPipeline(): Promise<Pipeline> {
  const path = "../pipeline.ts"; // src/pipeline.ts, owned by the pipeline module
  try {
    const mod = (await import(path)) as { pipeline?: Pipeline };
    if (!mod.pipeline) throw new Error("src/pipeline.ts does not export `pipeline`");
    return mod.pipeline;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND") {
      console.error("Cannot start: src/pipeline.ts is missing. It must export `pipeline: { validateUrl, run }` (see src/worker/pipeline.ts for the type).");
    } else {
      console.error(`Cannot start: failed to load src/pipeline.ts: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

async function main() {
  const config = loadConfig();
  const pipeline = await loadPipeline();
  mkdirSync(config.dataDir, { recursive: true });

  const db = openDb(join(config.dataDir, "worker.sqlite"));
  const queue = new JobQueue(db);
  const limits = new Limits(db, {
    ipPerHour: Number(process.env.LIMIT_IP_PER_HOUR ?? 5),
    emailPerDay: Number(process.env.LIMIT_EMAIL_PER_DAY ?? 3),
    domainPerDay: Number(process.env.LIMIT_DOMAIN_PER_DAY ?? 3),
    maxQueueDepth: Number(process.env.MAX_QUEUE_DEPTH ?? 50),
  });

  const e = process.env;
  const storage: Storage = e.R2_ENDPOINT && e.R2_BUCKET && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY
    ? new S3Storage({ endpoint: e.R2_ENDPOINT, bucket: e.R2_BUCKET, accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY })
    : new LocalStorage(join(config.dataDir, "store"));
  log(`storage: ${storage instanceof S3Storage ? "r2" : "local"}`);

  // Nothing is running yet, so any "running" job is a leftover from a crash.
  const [requeued, failed] = queue.recover(0);
  if (requeued || failed) log(`recovered jobs: requeued=${requeued} failed=${failed}`);

  const runner = new Runner({
    queue, storage, pipeline, secret: config.secret, region: config.region, concurrency: config.concurrency,
    jobTimeoutMs: config.jobTimeoutMs, retentionDays: config.retentionDays, reportBaseUrl: config.reportBaseUrl,
    webhook: { url: config.webhookUrl, secret: config.webhookSecret }, log,
  });

  const server = createWorkerServer({
    config, queue, limits, storage, pipeline,
    verifyTurnstile: async (token, ip) => {
      const r = await verifyTurnstile(token, ip);
      if (!r.ok) log(`turnstile rejected: ${r.reason}`);
      return r.ok;
    },
    log,
  });

  runner.start();
  const staleTimer = setInterval(() => queue.recover(), 60_000);
  const cleanup = () => runCleanup({ queue, storage, limits, retentionDays: config.retentionDays })
    .then((r) => log(`cleanup: reports=${r.reports} files=${r.files}`)).catch((err) => log(`cleanup failed: ${err.message}`));
  const cleanupTimer = setInterval(cleanup, 24 * 3600_000);
  void cleanup();

  server.listen(config.port, config.host, () => log(`worker listening on ${config.host}:${config.port}, concurrency ${config.concurrency}`));

  const shutdown = async () => {
    log("shutting down");
    clearInterval(staleTimer); clearInterval(cleanupTimer);
    server.close();
    await Promise.race([runner.stop(), new Promise((r) => setTimeout(r, 20_000))]);
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
