import { test } from "node:test";
import assert from "node:assert/strict";
import { keepFinishedScenarios } from "./runner.ts";
import { buildReport } from "../core/report.ts";
import { renderReportHtml } from "../report/render.ts";
import { capture, leadSite, run, shopSite } from "../core/rules/fixtures.ts";
import { scanTimeoutMs } from "../pipeline.ts";

const now = new Date("2026-10-24T12:00:00Z");

test("budget ran out after the site loaded: keep finished scenarios, mark incomplete, not aborted", () => {
  const { capture: c } = leadSite();
  // "reject" was cut short by the budget, so the runner never pushed it.
  c.scenarios = c.scenarios.filter((s) => s.scenario !== "reject");
  c.conversionPoints[0].walk.push({ name: "form_start", action: "focused message field", ok: true, pageUrl: c.target, ts: 9000, scenario: "reject" });
  keepFinishedScenarios(c, 180_000);
  assert.equal(c.aborted, undefined);
  assert.deepEqual(c.incomplete, { reason: "time_budget", detail: "run exceeded 180000 ms", done: ["none", "accept"] });
  assert.deepEqual(c.conversionPoints[0].walk.map((s) => s.scenario), ["accept"], "walk steps of the unfinished scenario are dropped");
});

test("budget ran out before any scenario finished or the site loaded: real timeout", () => {
  const none = capture({ target: "https://slow.example/", scenarios: [] });
  keepFinishedScenarios(none, 180_000);
  assert.equal(none.aborted?.reason, "timeout");
  assert.equal(none.incomplete, undefined);

  const noPage = capture({ target: "https://slow.example/", pages: [], scenarios: [run("none", "not_applicable")] });
  keepFinishedScenarios(noPage, 180_000);
  assert.equal(noPage.aborted?.reason, "timeout");
});

test("an earlier abort (bot wall, unreachable) is kept as is", () => {
  const c = capture({ target: "https://wall.example/", aborted: { reason: "bot_protection", detail: "challenge page" } });
  keepFinishedScenarios(c, 180_000);
  assert.equal(c.aborted?.reason, "bot_protection");
  assert.equal(c.incomplete, undefined);
});

test("incomplete scan: rules still run, report says time limit, never 'took too long to load'", () => {
  const { capture: c, hits } = leadSite();
  c.scenarios = c.scenarios.filter((s) => s.scenario !== "reject");
  keepFinishedScenarios(c, 180_000);
  const r = buildReport(c, hits, "free", "rep-budget", { now });
  assert.equal(r.scan.aborted, undefined);
  assert.deepEqual(r.scan.incomplete?.done, ["none", "accept"]);
  assert.ok(r.findings.length > 0, "findings from the finished scenarios are reported");
  assert.notEqual(r.conversions.find((x) => x.type === "lead")?.status, "not_testable");
  const html = renderReportHtml(r, { kind: "free", bookUrl: "https://strativra.com/audit" });
  assert.match(html, /The scan hit its time limit\./);
  assert.match(html, /before any cookie choice and after accepting cookies/);
  assert.doesNotMatch(html, /took too long to load/);
  assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ""), /[–—]/, "no dashes in visible text");
});

test("incomplete scan with an unwalked path says so, not 'could not walk safely'", () => {
  const { capture: c, hits } = shopSite();
  // The purchase path was only walked in "reject", which the budget cut short.
  for (const s of c.conversionPoints[0].walk) s.scenario = "reject";
  c.scenarios = c.scenarios.filter((s) => s.scenario !== "reject");
  keepFinishedScenarios(c, 180_000);
  assert.equal(c.conversionPoints[0].walk.length, 0);
  const r = buildReport(c, hits, "free", "rep-budget2", { now, rules: [] });
  assert.match(r.conversions.find((x) => x.type === "purchase")?.summary ?? "", /ran out of time before it could walk this path/);
});

test("SCAN_TIMEOUT_MS: default 180 s, override, floor at 30 s", () => {
  assert.equal(scanTimeoutMs({}), 180_000);
  assert.equal(scanTimeoutMs({ SCAN_TIMEOUT_MS: "200000" }), 200_000);
  assert.equal(scanTimeoutMs({ SCAN_TIMEOUT_MS: "5" }), 180_000);
  assert.equal(scanTimeoutMs({ SCAN_TIMEOUT_MS: "abc" }), 180_000);
});
