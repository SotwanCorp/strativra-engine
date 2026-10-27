import type { JobQueue } from "./queue.ts";
import type { Limits } from "./limits.ts";
import type { Storage } from "./storage.ts";

/** Delete expired report rows, their files, stale local files and old rate-limit hits. */
export async function runCleanup(o: { queue: JobQueue; storage: Storage; limits: Limits; retentionDays: number }): Promise<{ reports: number; files: number }> {
  const ids = o.queue.purgeExpired(o.retentionDays * 86400_000);
  for (const id of ids) await o.storage.deleteReport(id);
  const files = await o.storage.deleteOlderThan(o.retentionDays);
  o.limits.prune();
  return { reports: ids.length, files };
}
