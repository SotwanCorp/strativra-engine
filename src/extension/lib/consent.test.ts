import { test } from "node:test";
import assert from "node:assert/strict";
import { autoMarker, buttonMarker, consentChoiceFromPush, resolveMarkerTs } from "./consent.ts";

test("gtag consent updates map to accept / reject", () => {
  assert.equal(consentChoiceFromPush({ __gtag: ["consent", "update", { ad_storage: "granted", analytics_storage: "granted" }] }), "accept");
  assert.equal(consentChoiceFromPush({ __gtag: ["consent", "update", { ad_storage: "denied", analytics_storage: "granted" }] }), "accept");
  assert.equal(consentChoiceFromPush({ __gtag: ["consent", "update", { ad_storage: "denied", analytics_storage: "denied" }] }), "reject");
  assert.equal(consentChoiceFromPush(["consent", "update", { analytics_storage: "denied" }]), "reject");
  assert.equal(consentChoiceFromPush({ __gtag: ["consent", "default", { ad_storage: "denied" }] }), null);
  assert.equal(consentChoiceFromPush({ __gtag: ["consent", "update", { functionality_storage: "granted" }] }), null);
  assert.equal(consentChoiceFromPush({ event: "consent_update", value: "granted" }), null);
  assert.equal(consentChoiceFromPush(null), null);
});

test("the button marker moves back to the last page click before the press", () => {
  const start = 1000;
  assert.equal(resolveMarkerTs(10_000, [2000, 6000, 12_000], start), 6000);
  assert.equal(resolveMarkerTs(10_000, [], start), 10_000);
  assert.equal(resolveMarkerTs(100_000, [2000], start), 100_000, "older than 60 s: the press itself");
  assert.equal(resolveMarkerTs(10_000, [500], start), 10_000, "clicks before the start do not count");
  assert.deepEqual(buttonMarker(10_000, "reject", [7000], start), { ts: 7000, choice: "reject", source: "button" });
});

test("auto marker: a fresh visitor needs a click first, a returning visitor does not", () => {
  const base = { choice: "accept" as const, startedAt: 1000 };
  assert.equal(autoMarker({ ...base, pushT: 3000, visitor: "fresh", clicks: [] }), null);
  assert.deepEqual(autoMarker({ ...base, pushT: 3000, visitor: "fresh", clicks: [2900] }), { ts: 2900, choice: "accept", source: "auto" });
  assert.deepEqual(autoMarker({ ...base, pushT: 30_000, visitor: "fresh", clicks: [2900] }), { ts: 30_000, choice: "accept", source: "auto" }, "click too far back: the push time");
  assert.deepEqual(autoMarker({ ...base, pushT: 3000, visitor: "returning", clicks: [] }), { ts: 3000, choice: "accept", source: "auto" });
  assert.equal(autoMarker({ ...base, pushT: 500, visitor: "returning", clicks: [] }), null, "before the start");
  assert.equal(
    autoMarker({ ...base, pushT: 9000, visitor: "fresh", clicks: [8000], current: { ts: 5000, choice: "reject", source: "button" } }),
    null,
    "an existing marker wins",
  );
});
