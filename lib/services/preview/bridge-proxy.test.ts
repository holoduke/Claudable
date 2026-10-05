import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { BRIDGE_PROXY_SRC } from './bridge-proxy';

interface Injector { push(c: Buffer): Buffer | null; end(): Buffer | null }
interface ProxyHandle { listening: Promise<net.Server>; close(): Promise<void> }
interface ProxyModule {
  TAG: string;
  findInsertion(html: string): number;
  createInjector(tag?: string, max?: number): Injector;
  wantsHtml(h: Record<string, string>): boolean;
  upstreamRequestHeaders(h: Record<string, string>): Record<string, string>;
  isInjectable(method: string, status: number, h: Record<string, string>): boolean;
  patchCsp(v: string | string[]): string | string[];
  startBridgeProxy(o: { port: number; upstreamPort: number; bridgeFile: string; host?: string; pollMs?: number }): ProxyHandle;
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-proxy-'));
const PROXY_FILE = path.join(DIR, 'proxy.cjs');
const BRIDGE_FILE = path.join(DIR, 'bridge.js');
fs.writeFileSync(PROXY_FILE, BRIDGE_PROXY_SRC);
fs.writeFileSync(BRIDGE_FILE, '/* bridge */ window.__b = 1;');
const P = createRequire(import.meta.url)(PROXY_FILE) as ProxyModule;
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

const run = (chunks: string[], max?: number) => {
  const inj = P.createInjector(P.TAG, max);
  const out: Buffer[] = [];
  for (const c of chunks) { const o = inj.push(Buffer.from(c, 'utf8')); if (o) out.push(o); }
  const e = inj.end(); if (e) out.push(e);
  return Buffer.concat(out).toString('utf8');
};

describe('HTML injection', () => {
  it('inserts right after <head> (with attributes), not into <header>', () => {
    expect(run(['<!doctype html><html><head lang="x"><title>t</title></head><body><header>h</header></body></html>']))
      .toBe(`<!doctype html><html><head lang="x">${P.TAG}<title>t</title></head><body><header>h</header></body></html>`);
    expect(P.findInsertion('<html><header>x</header><body>')).toBe('<html><header>x</header><body>'.length);
  });
  it('falls back to before </head>, then after <body>, else leaves the document alone', () => {
    expect(P.findInsertion('<title>x</title></head><body>')).toBe('<title>x</title>'.length);
    expect(run(['<body class="a"><p>hi</p></body>'])).toBe(`<body class="a">${P.TAG}<p>hi</p></body>`);
    expect(run(['<p>just a fragment</p>'])).toBe('<p>just a fragment</p>');
  });
  it('handles <head> split across chunk boundaries and multi-byte chars split across chunks', () => {
    expect(run(['<html><he', 'ad><meta charset="utf-8">', '</head></html>'])).toBe(`<html><head>${P.TAG}<meta charset="utf-8"></head></html>`);
    const euro = Buffer.from('<p>€</p><head>', 'utf8');
    const inj = P.createInjector();
    const parts = [inj.push(euro.subarray(0, 4)), inj.push(euro.subarray(4)), inj.end()].filter(Boolean) as Buffer[];
    expect(Buffer.concat(parts).toString('utf8')).toBe(`<p>€</p><head>${P.TAG}`);
  });
  it('stops buffering after the limit and passes the rest through', () => {
    const big = 'x'.repeat(100);
    expect(run([big, big, '<head>'], 150)).toBe(`${big}${big}<head>`);
  });
  it('only rewrites 2xx uncompressed text/html with a body', () => {
    expect(P.isInjectable('GET', 200, { 'content-type': 'text/html; charset=utf-8' })).toBe(true);
    expect(P.isInjectable('GET', 200, { 'content-type': 'application/json' })).toBe(false);
    expect(P.isInjectable('GET', 404, { 'content-type': 'text/html' })).toBe(false);
    expect(P.isInjectable('GET', 304, { 'content-type': 'text/html' })).toBe(false);
    expect(P.isInjectable('HEAD', 200, { 'content-type': 'text/html' })).toBe(false);
    expect(P.isInjectable('GET', 200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })).toBe(false);
  });
  it('strips Accept-Encoding only for HTML requests, and hop-by-hop headers always', () => {
    const nav = P.upstreamRequestHeaders({ accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'gzip, br', connection: 'keep-alive', host: 'h' });
    expect(nav).toEqual({ accept: 'text/html,application/xhtml+xml', host: 'h' });
    const js = P.upstreamRequestHeaders({ accept: '*/*', 'accept-encoding': 'gzip' });
    expect(js['accept-encoding']).toBe('gzip');
    expect(P.wantsHtml({ accept: 'application/json' })).toBe(false);
  });
  it("adds 'self' to a script-src only when trivially possible", () => {
    expect(P.patchCsp("default-src 'none'; script-src 'nonce-abc'")).toBe("default-src 'none'; script-src 'nonce-abc' 'self'");
    expect(P.patchCsp("script-src 'self' 'unsafe-eval'")).toBe("script-src 'self' 'unsafe-eval'");
    expect(P.patchCsp("script-src 'nonce-a' 'strict-dynamic'")).toBe("script-src 'nonce-a' 'strict-dynamic'");
    expect(P.patchCsp("default-src https:")).toBe('default-src https:');
  });
});

// --- integration: a real upstream + the proxy, in-process ---------------------------------

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const canConnect = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
const get = (port: number, p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});

function upstreamServer(): http.Server {
  const binary = Buffer.from([0, 1, 2, 0xff, 0x3c, 0x68, 0x65, 0x61, 0x64, 0x3e]); // contains "<head>" bytes
  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      const [a, b] = ['<!doctype html><html><he', 'ad><title>t</title></head><body></body></html>'];
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': String(a.length + b.length), ETag: '"x"', 'X-Seen-Encoding': String(req.headers['accept-encoding'] ?? '') });
      res.write(a);
      setTimeout(() => res.end(b), 20);
    } else if (req.url === '/api') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"head":"<head>"}');
    } else if (req.url === '/bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(binary.length) });
      res.end(binary);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><head></head>missing</html>');
    }
  });
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
    socket.on('end', () => socket.end());
  });
  return server;
}

describe('bridge proxy (integration)', () => {
  it('waits for the upstream, injects HTML, passes JSON/binary, serves the bridge, proxies upgrades, 502s when upstream dies', async () => {
    const upPort = await freePort();
    const proxyPort = await freePort();
    const proxy = P.startBridgeProxy({ port: proxyPort, upstreamPort: upPort, bridgeFile: BRIDGE_FILE, host: '127.0.0.1', pollMs: 50 });
    try {
      // Not listening while the dev server is down (readiness semantics preserved).
      await new Promise((r) => setTimeout(r, 200));
      expect(await canConnect(proxyPort)).toBe(false);

      const upstream = upstreamServer();
      await new Promise<void>((r) => upstream.listen(upPort, '127.0.0.1', () => r()));
      await proxy.listening;
      expect(await canConnect(proxyPort)).toBe(true);

      const page = await get(proxyPort, '/page', { accept: 'text/html', 'accept-encoding': 'gzip' });
      expect(page.status).toBe(200);
      expect(page.body.toString()).toContain(`<head>${P.TAG}<title>t</title>`);
      expect(page.headers['content-length']).toBeUndefined();
      expect(page.headers.etag).toBeUndefined();
      expect(page.headers['x-seen-encoding']).toBe('');

      const api = await get(proxyPort, '/api', { accept: 'application/json' });
      expect(api.body.toString()).toBe('{"head":"<head>"}');
      const bin = await get(proxyPort, '/bin');
      expect([...bin.body]).toEqual([0, 1, 2, 0xff, 0x3c, 0x68, 0x65, 0x61, 0x64, 0x3e]);
      const missing = await get(proxyPort, '/nope', { accept: 'text/html' });
      expect(missing.status).toBe(404);
      expect(missing.body.toString()).not.toContain(P.TAG);

      const bridge = await get(proxyPort, '/__claudable/bridge.js?v=1');
      expect(bridge.status).toBe(200);
      expect(bridge.headers['cache-control']).toBe('no-store');
      expect(bridge.body.toString()).toBe('/* bridge */ window.__b = 1;');

      // Raw WebSocket-style upgrade handshake, then bytes both ways.
      const reply = await new Promise<string>((resolve, reject) => {
        const s = net.connect({ port: proxyPort, host: '127.0.0.1' });
        let buf = '';
        s.on('connect', () => s.write('GET /_hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
        s.on('data', (d: Buffer) => {
          buf += d.toString();
          if (buf.includes('\r\n\r\n') && !buf.includes('echo:')) s.write('ping');
          if (buf.includes('echo:ping')) { s.destroy(); resolve(buf); }
        });
        s.on('error', reject);
      });
      expect(reply).toContain('101 Switching Protocols');
      expect(reply).toContain('echo:ping');

      // Upstream gone → 502 per request, proxy stays up.
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
      const dead = await get(proxyPort, '/page', { accept: 'text/html' });
      expect(dead.status).toBe(502);
      expect(await canConnect(proxyPort)).toBe(true);
    } finally {
      await proxy.close();
    }
  });
});
