import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTurnstile, SITEVERIFY_URL } from "./turnstile.ts";

const fakeFetch = (success: boolean, calls: { url: string; body: string }[] = []): typeof fetch =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ success, "error-codes": success ? [] : ["invalid-input-response"] }), { status: 200 });
  }) as unknown as typeof fetch;

test("posts secret, response and remoteip to siteverify", async () => {
  const calls: { url: string; body: string }[] = [];
  const r = await verifyTurnstile("tok", "203.0.113.1", { secret: "s3", fetch: fakeFetch(true, calls), env: {} });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, SITEVERIFY_URL);
  const p = new URLSearchParams(calls[0].body);
  assert.equal(p.get("secret"), "s3");
  assert.equal(p.get("response"), "tok");
  assert.equal(p.get("remoteip"), "203.0.113.1");
});

test("rejects invalid token, missing token, network error", async () => {
  assert.deepEqual(await verifyTurnstile("bad", undefined, { secret: "s", fetch: fakeFetch(false), env: {} }), { ok: false, reason: "invalid-input-response" });
  assert.equal((await verifyTurnstile(undefined, undefined, { secret: "s", fetch: fakeFetch(true), env: {} })).ok, false);
  const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
  assert.equal((await verifyTurnstile("t", undefined, { secret: "s", fetch: boom, env: {} })).ok, false);
});

test("bypass only in test env or with explicit opt-in and no secret", async () => {
  assert.equal((await verifyTurnstile(undefined, undefined, { env: { NODE_ENV: "test" } })).ok, true);
  assert.equal((await verifyTurnstile(undefined, undefined, { env: {} })).ok, false);
  const warns: string[] = [];
  assert.equal((await verifyTurnstile(undefined, undefined, { env: { ALLOW_NO_TURNSTILE: "1" }, warn: (m) => warns.push(m) })).ok, true);
  assert.equal(warns.length, 1);
  // opt-in flag does not bypass when a secret is configured
  assert.equal((await verifyTurnstile("x", undefined, { secret: "s", fetch: fakeFetch(false), env: { ALLOW_NO_TURNSTILE: "1" } })).ok, false);
});
