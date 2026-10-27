import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startGuardProxy } from "./guard-proxy.ts";

function listen(host: string): Promise<{ server: http.Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.end("hello");
  });
  return new Promise((resolve) => server.listen(0, host, () => resolve({ server, port: (server.address() as net.AddressInfo).port, hits })));
}

function viaProxy(proxyUrl: string, target: string): Promise<{ status: number; body: string }> {
  const p = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: p.port, method: "GET", path: target, headers: { host: new URL(target).host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectVia(proxyUrl: string, target: string): Promise<string> {
  const p = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(p.port), p.hostname, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once("data", (d) => {
      resolve(d.toString().split("\r\n")[0]);
      s.destroy();
    });
    s.on("error", reject);
  });
}

test("guard proxy forwards allowed loopback (test mode) and blocks other private targets", async () => {
  const pub = await listen("127.0.0.1");
  const secret = await listen("127.0.0.2");
  const proxy = await startGuardProxy({ allowPrivate: true });
  try {
    const ok = await viaProxy(proxy.url, `http://127.0.0.1:${pub.port}/hi`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "hello");
    const bad = await viaProxy(proxy.url, `http://127.0.0.2:${secret.port}/secret`);
    assert.equal(bad.status, 403);
    assert.equal(secret.hits.length, 0, "private target never reached");
    assert.match(await connectVia(proxy.url, `127.0.0.2:${secret.port}`), / 403 /);
    assert.match(await connectVia(proxy.url, `169.254.169.254:80`), / 403 /);
    assert.match(await connectVia(proxy.url, `127.0.0.1:${pub.port}`), / 200 /);
    assert.equal(secret.hits.length, 0);
    assert.ok(proxy.blocked.some((b) => b.host === "169.254.169.254"));
  } finally {
    await proxy.close();
    pub.server.close();
    secret.server.close();
  }
});

test("guard proxy without allowPrivate blocks loopback too", async () => {
  const pub = await listen("127.0.0.1");
  const proxy = await startGuardProxy();
  try {
    const r = await viaProxy(proxy.url, `http://127.0.0.1:${pub.port}/`);
    assert.equal(r.status, 403);
    assert.equal(pub.hits.length, 0);
  } finally {
    await proxy.close();
    pub.server.close();
  }
});
