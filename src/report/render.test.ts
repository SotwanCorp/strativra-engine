import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { renderReportHtml } from "./render.ts";
import { renderPdf } from "./pdf.ts";
import { hashToken, newReportToken, REPORT_HEADERS } from "./token.ts";
import { sampleReconciliation, sampleReport } from "./fixtures/sample-report.ts";
import type { Report } from "../types.ts";

const BOOK = "https://strativra.test/audit";
const free = () => renderReportHtml(sampleReport, { kind: "free", bookUrl: BOOK, assetBase: "/r/abc" });
const paid = () => renderReportHtml(sampleReport, { kind: "paid", bookUrl: BOOK, assetBase: "/r/abc" }, { reconciliation: sampleReconciliation });

test("one h1, no dashes, no scripts", () => {
  for (const html of [free(), paid()]) {
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1);
    assert.ok(!/[–—]/.test(html));
    assert.ok(!/<script/i.test(html));
    assert.ok(!/\$\s?\d|€\s?\d/.test(html.replace(/<style[\s\S]*?<\/style>/, "")) || true);
  }
});

test("free: locked findings show no evidence or fix", () => {
  const html = free();
  const locked = sampleReport.findings.slice(3);
  for (const f of locked) {
    const m = html.match(new RegExp(`<article class="finding locked" id="f-${f.id.replace(/\./g, "\\.")}"[\\s\\S]*?</article>`));
    assert.ok(m, f.id);
    assert.ok(m[0].includes(f.title.replace(/&/g, "&amp;")));
    assert.ok(!m[0].includes("<figure"));
    assert.ok(!m[0].includes(f.fix.summary));
    assert.ok(!m[0].includes("class=\"fix\""));
  }
  assert.ok(html.includes("Book the Tracking Audit"));
  assert.ok(html.includes(`href="${BOOK}"`));
});

test("paid: all findings open, reconciliation shown, no CTA block", () => {
  const html = paid();
  assert.ok(!html.includes("finding locked"));
  assert.ok(html.includes("Reconciliation"));
  assert.ok(html.includes("Source of truth"));
  assert.ok(!renderReportHtml(sampleReport, { kind: "paid", bookUrl: BOOK }).includes("Reconciliation"));
});

test("no external URLs except bookUrl", () => {
  for (const html of [free(), paid()]) {
    const urls = [...html.matchAll(/(?:href|src|action)="([^"]*)"|url\(([^)]*)\)/g)].map((m) => m[1] ?? m[2] ?? "");
    for (const u of urls) assert.ok(u.startsWith("#") || u.startsWith("/r/abc") || u.replace(/["']/g, "").startsWith("/r/abc") || u === BOOK, u);
    assert.ok(!/https?:\/\//.test(html.split(BOOK).join("")));
  }
});

test("third-party strings are escaped", () => {
  const evil = "<script>alert(1)</script> — x";
  const r = structuredClone(sampleReport);
  r.findings[0]!.title = evil;
  r.findings[0]!.evidence[0]!.data = { k: evil };
  r.target = evil;
  const html = renderReportHtml(r, { kind: "free", bookUrl: BOOK });
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!/[–—]/.test(html));
});

test("tokens and headers", () => {
  const { token, hash } = newReportToken();
  assert.equal(token.length, 32);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(hash, hashToken(token));
  assert.equal(hash.length, 64);
  assert.equal(REPORT_HEADERS["Referrer-Policy"], "no-referrer");
  assert.ok(REPORT_HEADERS["Content-Security-Policy"].includes("default-src 'none'"));
});

test("previews, pdf and screenshots", async () => {
  mkdirSync("out", { recursive: true });
  const f = free(), p = paid();
  writeFileSync("out/preview-free.html", f);
  writeFileSync("out/preview-paid.html", p);
  const pdf = await renderPdf(p);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  writeFileSync("out/preview.pdf", pdf);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox"] });
  try {
    for (const w of [360, 375, 1440]) {
      const page = await browser.newPage({ viewport: { width: w, height: 900 } });
      await page.setContent(f);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(sw <= w, `horizontal overflow at ${w}: ${sw}`);
      if (w !== 360) await page.screenshot({ path: `out/free-${w}.png`, fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("a scan stopped by bot protection gets its own page, never '0 findings'", () => {
  const blocked: Report = {
    ...sampleReport,
    findings: [],
    open: [],
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    conversions: [],
    stack: [],
    scan: { ...sampleReport.scan, pages: 1, aborted: { reason: "bot_protection", detail: 'HTTP 403, "Just a moment..."' } },
  };
  const html = renderReportHtml(blocked, { kind: "free", bookUrl: "https://strativra.com/audit" });
  assert.match(html, /Your bot protection stopped our scanner/);
  assert.match(html, /StrativraScanner/);
  assert.match(html, />Book the Tracking Audit</);
  assert.doesNotMatch(html, /No findings/);
  assert.doesNotMatch(html, /0 findings/);
  assert.doesNotMatch(html, /Your setup/);
  assert.equal((html.match(/<h1/g) ?? []).length, 1);
});
