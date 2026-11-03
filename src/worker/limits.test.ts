import assert from "node:assert/strict";
import { test } from "node:test";
import { hmacHash, registrableDomain } from "./crypto.ts";
import { Limits } from "./limits.ts";
import { memQueue } from "./helpers.test-util.ts";

const H = (ip = "ip1", email = "em1", domain = "d1") => ({ ipHash: ip, emailHash: email, domainHash: domain });

test("per IP limit with Retry-After", () => {
  let t = 0;
  const { limits } = memQueue(() => t);
  for (let i = 0; i < 5; i++) { assert.equal(limits.check(H("ip", `e${i}`, `d${i}`), 0).ok, true); limits.record(H("ip", `e${i}`, `d${i}`)); }
  t = 10 * 60_000;
  const r = limits.check(H("ip", "new", "newd"), 0);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.scope, "ip"); assert.equal(r.retryAfterSec, 50 * 60); }
  t = 61 * 60_000;
  assert.equal(limits.check(H("ip", "new", "newd"), 0).ok, true);
});

test("per email and per domain limits (3/day)", () => {
  const { limits } = memQueue();
  for (let i = 0; i < 3; i++) limits.record(H(`ip${i}`, "mail", `dom${i}`));
  const e = limits.check(H("fresh", "mail", "other"), 0);
  assert.ok(!e.ok && e.scope === "email");
  for (let i = 0; i < 3; i++) limits.record(H(`x${i}`, `m${i}`, "site"));
  const d = limits.check(H("fresh", "freshmail", "site"), 0);
  assert.ok(!d.ok && d.scope === "domain");
});

test("queue depth cap", () => {
  const { db } = memQueue();
  const limits = new Limits(db, { maxQueueDepth: 3 });
  assert.equal(limits.check(H(), 2).ok, true);
  const r = limits.check(H(), 3);
  assert.ok(!r.ok && r.scope === "queue" && r.retryAfterSec > 0);
});

test("limits survive a restart (same sqlite file)", async () => {
  const { tmp } = await import("./helpers.test-util.ts");
  const { openDb } = await import("./queue.ts");
  const path = `${tmp()}/w.sqlite`;
  const db1 = openDb(path);
  const l1 = new Limits(db1);
  for (let i = 0; i < 3; i++) l1.record(H(`i${i}`, "same", `d${i}`));
  db1.close();
  const l2 = new Limits(openDb(path));
  assert.equal(l2.check(H("z", "same", "zz"), 0).ok, false);
});

test("hashes are HMACs, never raw values", () => {
  const h = hmacHash("0123456789abcdef", "ip", "203.0.113.9");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes("203"));
  assert.notEqual(h, hmacHash("another-secret-123", "ip", "203.0.113.9"));
});

test("registrableDomain", () => {
  assert.equal(registrableDomain("www.shop.example.com"), "example.com");
  assert.equal(registrableDomain("a.b.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("example.com.tn"), "example.com.tn");
  assert.equal(registrableDomain("1.2.3.4"), "1.2.3.4");
});
