/**
 * Local SSRF-guard forward proxy. The browser is launched with this as its
 * proxy, so EVERY connection the browser opens (navigations, redirect hops,
 * subresources, iframes, workers, WebSockets, beacons) is checked at connect
 * time, not only the requests Playwright's `route` sees (route never sees
 * redirect hops).
 *
 * Direct mode: the host is resolved here, all addresses must be public, and
 * the socket connects to a validated address (DNS pinned, no rebinding gap).
 * Upstream mode (an egress proxy in front, e.g. a sandbox): the host is
 * checked here, then tunnelled with CONNECT through the upstream proxy.
 */

import http from "node:http";
import net from "node:net";
import { assertPublicHost, bareHost, SsrfError, type Resolver, type SsrfOptions } from "./ssrf.ts";

export interface GuardProxyOptions extends SsrfOptions {
  /** http://[user:pass@]host:port of an upstream egress proxy (CONNECT). */
  upstreamProxy?: string;
  /** Sandbox-only: with an upstream proxy, let names that fail local DNS through (hostname checks still apply). */
  dnsFailure?: "block" | "allow";
  resolver?: Resolver;
  onBlock?: (host: string, port: number, reason: string) => void;
}

export interface GuardProxy {
  /** e.g. http://127.0.0.1:41234 */
  url: string;
  blocked: Array<{ host: string; port: number; reason: string }>;
  close(): Promise<void>;
}

function splitHostPort(s: string, defPort: number): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: bareHost(m[1]), port };
}

export async function startGuardProxy(opts: GuardProxyOptions = {}): Promise<GuardProxy> {
  const blocked: GuardProxy["blocked"] = [];
  const sockets = new Set<net.Socket>();
  const upstream = opts.upstreamProxy ? new URL(opts.upstreamProxy) : null;

  function block(host: string, port: number, reason: string) {
    blocked.push({ host, port, reason });
    opts.onBlock?.(host, port, reason);
  }

  /** Returns an address to connect to (direct mode) or null for upstream mode. Throws when blocked. */
  async function vet(host: string): Promise<string | null> {
    try {
      const addrs = await assertPublicHost(host, opts);
      return upstream ? null : addrs[0].address;
    } catch (e) {
      if (e instanceof SsrfError && e.code === "dns_failed" && upstream && opts.dnsFailure === "allow") return null;
      throw e;
    }
  }

  function upstreamTunnel(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const u = upstream as URL;
      const sock = net.connect(Number(u.port || 80), u.hostname);
      sockets.add(sock);
      sock.once("close", () => sockets.delete(sock));
      const target = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
      let hdr = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
      if (u.username) {
        const cred = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
        hdr += `Proxy-Authorization: Basic ${cred}\r\n`;
      }
      sock.write(hdr + "\r\n");
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buf.length > 16384) fail(new Error("upstream header too large"));
          return;
        }
        sock.off("data", onData);
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString("latin1"))?.[1] ?? 0);
        if (status !== 200) return fail(new Error(`upstream CONNECT ${status}`));
        const rest = buf.subarray(end + 4);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
      };
      const fail = (e: Error) => {
        sock.destroy();
        reject(e);
      };
      sock.on("data", onData);
      sock.once("error", fail);
    });
  }

  async function openSocket(host: string, port: number): Promise<net.Socket> {
    const addr = await vet(host);
    if (addr === null) return upstreamTunnel(host, port);
    return new Promise((resolve, reject) => {
      const s = net.connect(port, addr);
      sockets.add(s);
      s.once("close", () => sockets.delete(s));
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP proxying: absolute-URI requests.
    let u: URL;
    try {
      u = new URL(req.url ?? "");
      if (u.protocol !== "http:") throw new Error("scheme");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = bareHost(u);
    const port = Number(u.port || 80);
    let sock: net.Socket;
    try {
      sock = await openSocket(host, port);
    } catch (e) {
      const reason = e instanceof SsrfError ? e.code : "connect_failed";
      if (e instanceof SsrfError) block(host, port, reason);
      res.writeHead(e instanceof SsrfError ? 403 : 502, { "content-type": "text/plain" }).end("blocked");
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const out = http.request(
      { method: req.method, path: u.pathname + u.search, headers, createConnection: () => sock, setHost: false },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.rawHeaders as unknown as http.OutgoingHttpHeaders);
        up.pipe(res);
      },
    );
    out.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(out);
  });

  server.on("connect", async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const hp = splitHostPort(req.url ?? "", 443);
    if (!hp) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    let up: net.Socket;
    try {
      up = await openSocket(hp.host, hp.port);
    } catch (e) {
      if (e instanceof SsrfError) {
        block(hp.host, hp.port, e.code);
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      } else {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) up.write(head);
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    up.pipe(client);
    client.pipe(up);
  });

  server.on("clientError", (_e, s) => s.destroy());

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
