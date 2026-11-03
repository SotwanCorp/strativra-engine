import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, createHostChecker, isBlockedHostname, isBlockedIp, normalizeUrl, SsrfError } from "./ssrf.ts";

const fakeDns = (map: Record<string, string[]>) => async (h: string) => {
  const a = map[h];
  if (!a) throw new Error("ENOTFOUND");
  return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

test("isBlockedIp: IPv4 block list", () => {
  for (const ip of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.0.0.2", "169.254.169.254", "172.16.0.1",
    "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "255.255.255.255", "1.2.3", "999.1.1.1",
  ]) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34"]) assert.equal(isBlockedIp(ip), false, ip);
});

test("isBlockedIp: IPv6 allow-list (2000::/3 only)", () => {
  for (const ip of ["::1", "::", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::1", "fc00::1", "fd12::1", "fe80::1",
    "ff02::1", "2001:db8::1", "2001:0:1::1", "2002::1", "3fff::1", "garbage"]) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ["2606:4700::1111", "2a00:1450:4001::1"]) assert.equal(isBlockedIp(ip), false, ip);
});

test("allowPrivate allows only 127.0.0.1 / ::1 / localhost", () => {
  const o = { allowPrivate: true };
  assert.equal(isBlockedIp("127.0.0.1", o), false);
  assert.equal(isBlockedIp("::1", o), false);
  assert.equal(isBlockedHostname("localhost", o), false);
  assert.equal(isBlockedIp("127.0.0.2", o), true);
  assert.equal(isBlockedIp("169.254.169.254", o), true);
  assert.equal(isBlockedIp("10.0.0.1", o), true);
  assert.equal(isBlockedHostname("localhost"), true);
});

test("isBlockedHostname: intranet names", () => {
  for (const h of ["localhost", "a.localhost", "printer.local", "x.internal", "box.localdomain", "r.home.arpa", "intranet", "[::1]"])
    assert.equal(isBlockedHostname(h), true, h);
  assert.equal(isBlockedHostname("example.com"), false);
});

test("normalizeUrl", () => {
  assert.equal(normalizeUrl("example.com").href, "https://example.com/");
  assert.equal(normalizeUrl("https://example.com/a#frag").href, "https://example.com/a");
  for (const bad of ["", "ftp://x.com", "https://u:p@x.com", "https://x.com:8080/", "javascript:alert(1)", "http://x .com"])
    assert.throws(() => normalizeUrl(bad), SsrfError, bad);
  assert.throws(() => normalizeUrl("http://127.0.0.1:8080/"), SsrfError);
  assert.equal(normalizeUrl("http://127.0.0.1:8080/", { allowPrivate: true }).port, "8080");
});

test("assertPublicUrl: every resolved address must be public", async () => {
  const resolver = fakeDns({ "ok.test.com": ["93.184.216.34"], "mixed.test.com": ["93.184.216.34", "10.0.0.5"], "v6.test.com": ["::1"] });
  assert.equal((await assertPublicUrl("https://ok.test.com/x", { resolver })).hostname, "ok.test.com");
  await assert.rejects(assertPublicUrl("https://mixed.test.com", { resolver }), (e: SsrfError) => e.code === "blocked_host");
  await assert.rejects(assertPublicUrl("https://v6.test.com", { resolver }), (e: SsrfError) => e.code === "blocked_host");
  await assert.rejects(assertPublicUrl("https://nx.test.com", { resolver }), (e: SsrfError) => e.code === "dns_failed");
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest", { resolver }), (e: SsrfError) => e.code === "blocked_host");
});

test("createHostChecker caches and fails closed on DNS errors", async () => {
  let calls = 0;
  const resolver = async (h: string) => {
    calls++;
    if (h === "pub.test.com") return [{ address: "8.8.8.8", family: 4 }];
    throw new Error("ENOTFOUND");
  };
  const c = createHostChecker({ resolver });
  assert.equal(await c.check("pub.test.com"), null);
  assert.equal(await c.check("pub.test.com"), null);
  assert.equal(calls, 1);
  assert.equal(c.peek("pub.test.com"), null);
  assert.equal(await c.check("nx.test.com"), "dns_failed");
  assert.equal(await c.check("10.0.0.1"), "blocked_host");
  const lax = createHostChecker({ resolver, dnsFailure: "allow" });
  assert.equal(await lax.check("nx.test.com"), null);
  assert.equal(await lax.check("192.168.0.1"), "blocked_host");
});
