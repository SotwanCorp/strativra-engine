import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Limits } from "./limits.ts";
import type { Pipeline } from "./pipeline.ts";
import { JobQueue, openDb } from "./queue.ts";

export function tmp(): string {
  return mkdtempSync(join(tmpdir(), "worker-test-"));
}

export function memQueue(now: () => number = Date.now) {
  const db = openDb(":memory:");
  return { db, queue: new JobQueue(db, now), limits: new Limits(db, {}, now) };
}

export function fakePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    async validateUrl(input: string) {
      const u = new URL(input.includes("://") ? input : `https://${input}`);
      if (u.hostname === "localhost" || u.hostname.startsWith("10.")) throw new Error("private address");
      return u;
    },
    async run(url, opts) {
      return { report: { target: url.href, reportId: opts.reportId }, html: `<html><body>report for ${url.hostname}<script>var a=1</script></body></html>`, pdf: Buffer.from("%PDF-fake") };
    },
    async fromCapture(upload, opts) {
      return { report: { target: upload.capture.target, reportId: opts.reportId }, html: `<html><body>recording of ${upload.capture.target}</body></html>`, pdf: Buffer.from("%PDF-fake") };
    },
    ...over,
  };
}
