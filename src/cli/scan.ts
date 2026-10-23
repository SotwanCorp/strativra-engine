/**
 * Local scan runner (owner's machine / dev sessions).
 *
 *   node --experimental-strip-types src/cli/scan.ts <url> [--out out/scan] [--paid] [--no-pdf] [--allow-private]
 *
 * Writes capture.json, report.json, report.html and report.pdf to --out.
 * --allow-private is for local fixture sites only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertPublicUrl } from "../core/net/ssrf.ts";
import { scan } from "../pipeline.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (!target) {
  console.error("Usage: scan.ts <url> [--out dir] [--paid] [--no-pdf] [--allow-private]");
  process.exit(2);
}

const out = path.resolve(opt("--out") ?? "out/scan");
const allowPrivate = flag("--allow-private");
const url = await assertPublicUrl(target, { allowPrivate });
await mkdir(out, { recursive: true });

const upstream = process.env.SCAN_UPSTREAM_PROXY;
const t = Date.now();
const res = await scan(url, {
  region: process.env.REGION_LABEL ?? "local",
  reportId: randomUUID(),
  screenshotDir: path.join(out, "shots"),
  kind: flag("--paid") ? "paid" : "free",
  pdf: !flag("--no-pdf"),
  run: { allowPrivate, ...(upstream ? { upstreamProxy: upstream, dnsFailure: "allow" as const } : {}) },
});
await writeFile(path.join(out, "capture.json"), JSON.stringify(res.capture, null, 1));
await writeFile(path.join(out, "report.json"), JSON.stringify(res.report, null, 1));
await writeFile(path.join(out, "report.html"), res.html);
if (res.pdf) await writeFile(path.join(out, "report.pdf"), res.pdf);

const r = res.report;
console.log(`${r.finalUrl}  ${((Date.now() - t) / 1000).toFixed(1)}s  pages=${r.scan.pages}  aborted=${r.scan.aborted?.reason ?? "no"}`);
console.log(`banner: ${JSON.stringify(r.scan.banner)}`);
console.log(`stack: ${r.stack.map((s) => `${s.name}${s.ids.length ? "(" + s.ids.join(",") + ")" : ""}`).join(", ")}`);
console.log(`conversions: ${r.conversions.map((c) => `${c.type}=${c.status}`).join(", ") || "none"}`);
console.log(`counts: ${JSON.stringify(r.counts)}  open: ${r.open.join(", ")}`);
for (const f of r.findings) console.log(`  [${f.severity}] ${f.id}: ${f.title}`);
console.log(`written to ${out}`);
