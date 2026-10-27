import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeConsent } from "./index.ts";

test("no consent params -> undefined", () => {
  assert.equal(decodeConsent(new URLSearchParams("v=2&tid=G-1")), undefined);
});

test("gcd all granted after update (13r3r3r3r5)", () => {
  const c = decodeConsent({ gcd: "13r3r3r3r5", gcs: "G111" });
  assert.ok(c);
  for (const k of ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"] as const) {
    assert.deepEqual(c.keys[k], { default: "denied", update: "granted", current: "granted" });
  }
  assert.deepEqual(c.unknownLetters, []);
  assert.equal(c.raw.gcd, "13r3r3r3r5");
});

test("gcd mixed slots incl. m/n/l/t/p and dma/npa raw", () => {
  const c = decodeConsent(new URLSearchParams("gcd=11p1t1m1n5&dma=1&npa=1"));
  assert.ok(c);
  assert.deepEqual(c.keys.ad_storage, { default: "denied", update: "unset", current: "denied" });
  assert.deepEqual(c.keys.analytics_storage, { default: "granted", update: "unset", current: "granted" });
  assert.deepEqual(c.keys.ad_user_data, { default: "unset", update: "denied", current: "denied" });
  assert.deepEqual(c.keys.ad_personalization, { default: "unset", update: "granted", current: "granted" });
  assert.equal(c.raw.dma, "1");
  assert.equal(c.raw.npa, "1");
});

test("gcd l = consent mode not detected", () => {
  const c = decodeConsent({ gcd: "13l3l3l3l5" });
  assert.deepEqual(c?.keys.ad_storage, { default: "unset", update: "unset", current: "unset" });
});

test("unknown gcd letter -> unknown + listed; gcs fills current", () => {
  const c = decodeConsent({ gcd: "13x3q3e3v5", gcs: "G101" });
  assert.ok(c);
  assert.deepEqual(c.unknownLetters, ["x", "e"]);
  assert.deepEqual(c.keys.ad_storage, { default: "unknown", update: "unknown", current: "denied" });
  assert.deepEqual(c.keys.analytics_storage, { default: "denied", update: "denied", current: "denied" });
  assert.deepEqual(c.keys.ad_user_data, { default: "unknown", update: "unknown", current: "unknown" });
});

test("gcs only (no gcd)", () => {
  for (const [gcs, ad, an] of [["G100", "denied", "denied"], ["G110", "granted", "denied"], ["G101", "denied", "granted"], ["G111", "granted", "granted"]] as const) {
    const c = decodeConsent({ gcs });
    assert.equal(c?.keys.ad_storage?.current, ad);
    assert.equal(c?.keys.analytics_storage?.current, an);
    assert.equal(c?.keys.ad_storage?.default, "unknown");
    assert.equal(c?.keys.ad_user_data, undefined);
  }
});

test("malformed gcs keeps raw only", () => {
  const c = decodeConsent({ gcs: "garbage" });
  assert.equal(c?.raw.gcs, "garbage");
  assert.deepEqual(c?.keys, {});
});
