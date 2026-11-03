/** Copy rules (strativra/CLAUDE.md): no em or en dashes, no prices, CTA labels only from the table. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allStrings, S } from "./strings.ts";
import { TEMPLATES } from "./templates.ts";

const visible = [
  ...allStrings(),
  ...Object.values(TEMPLATES).flatMap((t) => [t.name, ...t.steps.flatMap((s) => [s.label, s.action])]),
  readFileSync(new URL("../entrypoints/sidepanel/index.html", import.meta.url), "utf8"),
];

test("no em or en dashes in any visible string", () => {
  for (const s of visible) assert.doesNotMatch(s, /[–—]/, s);
});

test("no prices", () => {
  for (const s of visible) assert.doesNotMatch(s, /[$€£]\s?\d|\d\s?(?:EUR|USD|TND|dollars?|euros?)\b|\bfree trial\b/i, s);
});

test("CTA labels come from the table, no invented synonyms", () => {
  assert.equal(S.audit, "Book a Tracking Audit");
  for (const s of visible) assert.doesNotMatch(s, /get in touch|contact us|let's talk|book a call\b|book the tracking audit/i, s);
});
