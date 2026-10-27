/**
 * Tiny fixture server for browser tests (127.0.0.1, random port).
 * Records every request it receives so tests can assert what never arrived.
 *
 *   /             -> site/index.html (fake CMP + GA4-like /g/collect hits)
 *   /contact.html -> contact form (POST /submit must never arrive)
 *   /redirect     -> 302 to the "secret" server on 127.0.0.2 (must be blocked)
 *   /bot          -> 503 Cloudflare-like challenge
 *   /g/collect    -> 204 (tracking endpoint)
 */

import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");

export interface Hit {
  method: string;
  url: string;
  body: string;
}

export interface FixtureServer {
  origin: string;
  hits: Hit[];
  secretHits: Hit[];
  secretOrigin: string;
  close(): Promise<void>;
}

function collect(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => resolve(b));
  });
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const hits: Hit[] = [];
  const secretHits: Hit[] = [];
  const secret = http.createServer(async (req, res) => {
    secretHits.push({ method: req.method ?? "", url: req.url ?? "", body: await collect(req) });
    res.end("internal secret");
  });
  // 127.0.0.2 is loopback on Linux but NOT allowed by allowPrivate (only 127.0.0.1 is).
  await new Promise<void>((r) => secret.listen(0, "127.0.0.2", r));
  const secretOrigin = `http://127.0.0.2:${(secret.address() as net.AddressInfo).port}`;

  const server = http.createServer(async (req, res) => {
    const body = await collect(req);
    const url = req.url ?? "/";
    hits.push({ method: req.method ?? "", url, body });
    const p = url.split("?")[0];
    if (p === "/g/collect") {
      res.writeHead(204).end();
      return;
    }
    if (p === "/redirect") {
      res.writeHead(302, { location: `${secretOrigin}/secret` }).end();
      return;
    }
    if (p === "/bot") {
      res.writeHead(503, { "content-type": "text/html" });
      res.end('<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>');
      return;
    }
    const file = p === "/" ? "index.html" : p.replace(/^\//, "");
    if (!/^[\w-]+\.html$/.test(file)) {
      res.writeHead(req.method === "GET" ? 404 : 200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    try {
      const html = await readFile(path.join(SITE, file), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return {
    origin,
    hits,
    secretHits,
    secretOrigin,
    close: async () => {
      server.closeAllConnections();
      secret.closeAllConnections();
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => secret.close(r))]);
    },
  };
}
