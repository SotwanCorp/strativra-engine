import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { icsToConsent, INIT_SCRIPT } from "./init-script.ts";

type Read = () => { dataLayer: Array<{ t: number; p: unknown }>; ics: unknown; gtmKeys: string[]; dropped: number };

function sandbox() {
  const ctx: Record<string, unknown> = { setInterval, clearInterval, setTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(INIT_SCRIPT, ctx);
  return ctx;
}

test("records pushes on a dataLayer created later, with PII redacted", () => {
  const ctx = sandbox();
  vm.runInContext(
    `window.dataLayer = window.dataLayer || [];
     dataLayer.push({ event: "lead", email: "Jane.Doe+x@Example.co.uk", phone: "+33 6 12 34 56 78", short: "12345", order: 1234567890, nested: { note: "call 0612345678 or mail a@b.io" }, cb: function(){} });`,
    ctx,
  );
  const r = JSON.parse(JSON.stringify((ctx.__strvRead as Read)())) as ReturnType<Read>;
  assert.equal(r.dataLayer.length, 1);
  const p = r.dataLayer[0].p as Record<string, unknown>;
  assert.equal(p.event, "lead");
  assert.equal(p.email, "[email]");
  assert.match(String(p.phone), /^\[digits:[0-9a-f]+\]$/);
  assert.equal(p.short, "12345");
  assert.equal(p.order, 1234567890, "numbers are kept (values, ids)");
  assert.doesNotMatch(JSON.stringify(p.nested), /0612345678|a@b\.io/);
  assert.equal(p.cb, "[function]");
  assert.equal((ctx.__strvRead as Read)().dataLayer.length, 0, "read drains");
});

test("survives GTM replacing push (no double record, no recursion) and gtag arguments", () => {
  const ctx = sandbox();
  vm.runInContext(
    `window.dataLayer = [{ event: "early" }];
     var prev = dataLayer.push;
     var seen = [];
     dataLayer.push = function () { seen.push(arguments[0]); return prev.apply(dataLayer, arguments); };
     dataLayer.push({ event: "after_gtm" });
     function gtag(){ dataLayer.push(arguments); }
     gtag("consent", "default", { ad_storage: "denied" });`,
    ctx,
  );
  const r = JSON.parse(JSON.stringify((ctx.__strvRead as Read)())) as ReturnType<Read>;
  const events = r.dataLayer.map((e) => e.p);
  assert.deepEqual(events[0], { event: "early" });
  assert.deepEqual(events[1], { event: "after_gtm" });
  assert.deepEqual(events[2], { __gtag: ["consent", "default", { ad_storage: "denied" }] });
  assert.equal(events.length, 3);
  assert.equal(vm.runInContext("seen.length", ctx), 2, "GTM's push still runs");
  assert.equal(vm.runInContext("dataLayer.length", ctx), 3, "items land in the array once");
});

test("reads gtag consent state and GTM keys", () => {
  const ctx = sandbox();
  vm.runInContext(
    `window.google_tag_data = { ics: { entries: { ad_storage: { default: false, update: true }, analytics_storage: { default: false } } } };
     window.google_tag_manager = { "GTM-ABC": {}, "G-XYZ": {} };`,
    ctx,
  );
  const r = JSON.parse(JSON.stringify((ctx.__strvRead as Read)())) as ReturnType<Read>;
  assert.deepEqual(r.gtmKeys, ["GTM-ABC", "G-XYZ"]);
  const c = icsToConsent(r.ics as never);
  assert.deepEqual(c, { ad_storage: "granted", analytics_storage: "denied", ad_user_data: "unset", ad_personalization: "unset" });
  assert.equal(icsToConsent(null), undefined);
});
