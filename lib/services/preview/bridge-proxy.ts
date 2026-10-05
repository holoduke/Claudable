// Dependency-free reverse proxy that runs INSIDE a node preview container and
// injects the Claudable preview bridge into HTML pages — no project file touched.

/** Container port the bridge proxy listens on (the host publish maps to it). */
export const BRIDGE_CONTAINER_PORT = 39917;

/**
 * CommonJS source of the proxy. Claudable writes it to a Claudable-owned host
 * dir that is bind-mounted read-only into the container (bridge-assets.ts) and
 * starts it next to the dev server:
 *
 *   node /opt/claudable-bridge/proxy.cjs <listenPort> <upstreamPort>
 *
 * - Listens only once 127.0.0.1 (or ::1) :upstreamPort accepts TCP, so the
 *   published port refuses connections until the app is up (same readiness
 *   semantics as publishing the dev server directly). Upstream gone later →
 *   502 per request.
 * - Forwards every request verbatim (method, path, headers incl. Host, streamed
 *   body); Upgrade requests (HMR websockets) are piped raw both ways.
 * - Injects <script src="/__claudable/bridge.js"> after <head> (else before
 *   </head>, else after <body>) into 2xx text/html responses only, buffering at
 *   most 512KB until the insertion point; everything else passes untouched.
 *   HTML navigations are requested without Accept-Encoding so the body arrives
 *   uncompressed; a compressed HTML response is passed through untouched.
 * - CSP: a script-src (or script-src-elem) without 'self' gets 'self' appended,
 *   unless it uses 'strict-dynamic' or 'none' (then the header is left alone and
 *   the bridge simply does not run on that page). A policy that only has
 *   default-src is left alone too.
 * - Serves GET /__claudable/bridge.js itself (no-store) from bridge.js next to
 *   this file.
 * - Never crashes on client aborts / upstream errors (logs one line).
 *
 * When required (tests) it only exports its helpers; it starts when run as main.
 * Written with String.raw: no backticks or dollar-brace sequences inside the
 * proxy code itself (the only interpolation is BRIDGE_CONTAINER_PORT).
 */
export const BRIDGE_PROXY_SRC = String.raw`'use strict';
// Auto-written by Claudable (preview only): preview bridge proxy. Not part of the project.
var http = require('http');
var net = require('net');
var fs = require('fs');
var path = require('path');

var BRIDGE_PATH = '/__claudable/bridge.js';
var TAG = '<script src="/__claudable/bridge.js"></script>';
var MAX_BUFFER = 512 * 1024;
var HEAD_OPEN = /<head(?=[\s>\/])[^>]*>/i;
var HEAD_CLOSE = /<\/head\s*>/i;
var BODY_OPEN = /<body(?=[\s>\/])[^>]*>/i;
var HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

function log(msg) { try { process.stdout.write('[claudable-bridge] ' + msg + '\n'); } catch (e) { /* ignore */ } }
// Dev-server restarts make every request 502 for a while: one line per 5s per
// kind, worded so Claudable's diagnostics tap does not flag it as an app error.
var lastLogged = {};
function logThrottled(key, msg) {
  var now = Date.now();
  if (lastLogged[key] && now - lastLogged[key] < 5000) return;
  lastLogged[key] = now;
  log(msg);
}

/** Index where the tag goes, or -1 when no insertion point is known (yet). */
function findInsertion(html) {
  var m = HEAD_OPEN.exec(html);
  if (m) return m.index + m[0].length;
  m = HEAD_CLOSE.exec(html);
  if (m) return m.index;
  m = BODY_OPEN.exec(html);
  if (m) return m.index + m[0].length;
  return -1;
}

/** Streaming injector. push(chunk) / end() return a Buffer to write, or null. */
function createInjector(tag, maxBuffer) {
  var t = tag || TAG;
  var max = maxBuffer || MAX_BUFFER;
  var pending = '';
  var done = false;
  return {
    push: function (chunk) {
      if (done) return chunk;
      // latin1 maps bytes 1:1, so a multi-byte char split across chunks survives.
      pending += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : Buffer.from(String(chunk)).toString('latin1');
      var idx = findInsertion(pending);
      if (idx >= 0) {
        var out = pending.slice(0, idx) + t + pending.slice(idx);
        pending = ''; done = true;
        return Buffer.from(out, 'latin1');
      }
      if (pending.length > max) {
        var raw = pending; pending = ''; done = true;
        return Buffer.from(raw, 'latin1');
      }
      return null;
    },
    end: function () {
      if (done) return null;
      done = true;
      var raw = pending; pending = '';
      return raw ? Buffer.from(raw, 'latin1') : null;
    },
    injected: function () { return done; },
  };
}

function headerValue(v) { return Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v)); }

/** A browser navigation / HTML request: its Accept includes text/html. */
function wantsHtml(headers) { return /text\/html/i.test(headerValue(headers && headers.accept)); }

/** Request headers for upstream: hop-by-hop dropped; HTML requests lose Accept-Encoding. */
function upstreamRequestHeaders(headers) {
  var out = {};
  Object.keys(headers || {}).forEach(function (k) {
    var lk = k.toLowerCase();
    if (lk === 'connection' || lk === 'keep-alive' || lk === 'proxy-connection') return;
    out[k] = headers[k];
  });
  if (wantsHtml(headers)) delete out['accept-encoding'];
  return out;
}

/** Whether a response may be rewritten: 2xx, text/html, not encoded, has a body. */
function isInjectable(method, status, headers) {
  if (method === 'HEAD') return false;
  if (!(status >= 200 && status < 300) || status === 204) return false;
  if (!/^\s*text\/html/i.test(headerValue(headers['content-type']))) return false;
  var enc = headerValue(headers['content-encoding']).trim().toLowerCase();
  return enc === '' || enc === 'identity';
}

function patchCspValue(value) {
  var parts = String(value).split(';');
  var changed = false;
  for (var i = 0; i < parts.length; i++) {
    var tokens = parts[i].trim().split(/\s+/);
    var name = (tokens[0] || '').toLowerCase();
    if (name !== 'script-src' && name !== 'script-src-elem') continue;
    var lower = tokens.slice(1).map(function (s) { return s.toLowerCase(); });
    if (lower.indexOf("'self'") >= 0 || lower.indexOf('*') >= 0) continue;
    if (lower.indexOf("'strict-dynamic'") >= 0 || lower.indexOf("'none'") >= 0) continue;
    parts[i] = ' ' + tokens.join(' ') + " 'self'";
    changed = true;
  }
  return changed ? parts.join(';').replace(/^\s+/, '') : value;
}

/** CSP header (string or array): allow the same-origin bridge when trivially possible. */
function patchCsp(value) {
  if (Array.isArray(value)) return value.map(patchCspValue);
  if (typeof value !== 'string') return value;
  return patchCspValue(value);
}

function rewrittenResponseHeaders(headers) {
  var out = {};
  Object.keys(headers).forEach(function (k) {
    var lk = k.toLowerCase();
    if (HOP_BY_HOP.indexOf(lk) >= 0) return;
    if (lk === 'content-length' || lk === 'etag' || lk === 'content-md5') return;
    out[k] = lk === 'content-security-policy' ? patchCsp(headers[k]) : headers[k];
  });
  return out;
}

function passResponseHeaders(headers) {
  var out = {};
  Object.keys(headers).forEach(function (k) {
    if (HOP_BY_HOP.indexOf(k.toLowerCase()) >= 0) return;
    out[k] = headers[k];
  });
  return out;
}

function probe(port, host, cb) {
  var s = net.connect({ port: port, host: host });
  var finished = false;
  var finish = function (ok) { if (finished) return; finished = true; s.destroy(); cb(ok); };
  s.setTimeout(1000, function () { finish(false); });
  s.on('connect', function () { finish(true); });
  s.on('error', function () { finish(false); });
}

/**
 * Start the proxy. Resolves the listening server once the upstream accepted a
 * TCP connection. opts: { port, upstreamPort, bridgeFile, host?, pollMs? }.
 */
function startBridgeProxy(opts) {
  var port = opts.port;
  var upstreamPort = opts.upstreamPort;
  var bridgeFile = opts.bridgeFile;
  var host = opts.host || '0.0.0.0';
  var pollMs = opts.pollMs || 300;
  var upstreamHost = '127.0.0.1';
  var agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  var stopped = false;
  var pollTimer = null;

  function serveBridge(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    fs.readFile(bridgeFile, function (err, data) {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('bridge not available'); return; }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  function badGateway(res, err) {
    logThrottled('http', 'dev server unreachable (' + (err && (err.code || err.message)) + '), answered 502');
    if (!res.headersSent) {
      try { res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Bad gateway (dev server not reachable)'); } catch (e) { res.destroy(); }
    } else {
      res.destroy();
    }
  }

  function forward(req, res, attempt) {
    var hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
    var up = http.request({ host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers: upstreamRequestHeaders(req.headers), agent: agent }, function (ures) {
      var status = ures.statusCode || 502;
      if (!isInjectable(req.method, status, ures.headers)) {
        res.writeHead(status, ures.statusMessage, passResponseHeaders(ures.headers));
        ures.pipe(res);
        ures.on('error', function () { res.destroy(); });
        return;
      }
      res.writeHead(status, ures.statusMessage, rewrittenResponseHeaders(ures.headers));
      var inj = createInjector(TAG, MAX_BUFFER);
      ures.on('data', function (c) { var out = inj.push(c); if (out && out.length) res.write(out); });
      ures.on('end', function () { var out = inj.end(); if (out && out.length) res.write(out); res.end(); });
      ures.on('error', function () { res.destroy(); });
    });
    up.on('error', function (err) {
      // A pooled keep-alive socket the dev server just closed: retry a body-less request once.
      if (attempt === 0 && !hasBody && up.reusedSocket && err && err.code === 'ECONNRESET' && !res.headersSent) { forward(req, res, 1); return; }
      badGateway(res, err);
    });
    res.on('close', function () { if (!res.writableFinished) up.destroy(); });
    if (hasBody) req.pipe(up); else up.end();
  }

  function onRequest(req, res) {
    try {
      var p = String(req.url || '/').split('?')[0];
      if (p === BRIDGE_PATH) return serveBridge(req, res);
      forward(req, res, 0);
    } catch (e) {
      badGateway(res, e);
    }
  }

  function onUpgrade(req, socket, head) {
    var u = net.connect({ port: upstreamPort, host: upstreamHost });
    var closeBoth = function () { socket.destroy(); u.destroy(); };
    u.on('connect', function () {
      var lines = [req.method + ' ' + req.url + ' HTTP/' + req.httpVersion];
      for (var i = 0; i < req.rawHeaders.length; i += 2) lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
      u.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) u.write(head);
      socket.pipe(u);
      u.pipe(socket);
    });
    u.on('error', function (err) {
      logThrottled('ws', 'websocket upstream unreachable (' + (err && (err.code || err.message)) + ')');
      try { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch (e) { /* ignore */ }
      closeBoth();
    });
    socket.on('error', closeBoth);
    // Server sockets are half-open capable: a client FIN alone would leave the
    // upstream connection dangling. WebSockets never half-close — tear down.
    socket.on('end', function () { u.destroy(); });
    u.on('end', function () { socket.end(); });
    u.on('close', function () { socket.destroy(); });
    socket.on('close', function () { u.destroy(); });
    try { socket.setNoDelay(true); u.setNoDelay(true); } catch (e) { /* ignore */ }
  }

  var server = http.createServer(onRequest);
  server.on('upgrade', onUpgrade);
  server.on('clientError', function (err, socket) {
    try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch (e) { /* ignore */ }
  });
  // Node's default: a client may take 5 min to send its request (headers +
  // body); responses (SSE, long polls) are not limited by this.
  server.requestTimeout = 300000;
  server.keepAliveTimeout = 61000;
  server.headersTimeout = 62000;

  var listening = new Promise(function (resolve) {
    var hosts = ['127.0.0.1', '::1'];
    var tryListen = function () {
      server.once('error', function (err) {
        log('cannot listen yet (' + (err && (err.code || err.message)) + '), retrying');
        setTimeout(tryListen, 1000);
      });
      server.listen(port, host, function () {
        server.removeAllListeners('error');
        server.on('error', function (err) { logThrottled('server', 'server problem: ' + (err && (err.code || err.message))); });
        log('listening on :' + port + ' -> ' + upstreamHost + ':' + upstreamPort);
        resolve(server);
      });
    };
    var poll = function (i) {
      if (stopped) return;
      probe(upstreamPort, hosts[i % 2], function (ok) {
        if (stopped) return;
        if (ok) { upstreamHost = hosts[i % 2]; tryListen(); return; }
        pollTimer = setTimeout(function () { poll(i + 1); }, i % 2 === 0 ? 0 : pollMs);
      });
    };
    log('waiting for the dev server on :' + upstreamPort);
    poll(0);
  });

  return {
    listening: listening,
    close: function () {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      agent.destroy();
      return new Promise(function (resolve) {
        if (!server.listening) { resolve(); return; }
        server.close(function () { resolve(); });
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
}

module.exports = {
  TAG: TAG,
  findInsertion: findInsertion,
  createInjector: createInjector,
  wantsHtml: wantsHtml,
  upstreamRequestHeaders: upstreamRequestHeaders,
  isInjectable: isInjectable,
  patchCsp: patchCsp,
  startBridgeProxy: startBridgeProxy,
};

if (require.main === module) {
  process.on('uncaughtException', function (e) { log('uncaught: ' + (e && e.message)); });
  process.on('unhandledRejection', function (e) { log('unhandled: ' + (e && e.message)); });
  var listenPort = parseInt(process.argv[2] || process.env.BRIDGE_PORT || '${BRIDGE_CONTAINER_PORT}', 10);
  var upstream = parseInt(process.argv[3] || process.env.BRIDGE_UPSTREAM_PORT || '', 10);
  if (!upstream) { log('no upstream port given; not starting'); }
  else startBridgeProxy({ port: listenPort, upstreamPort: upstream, bridgeFile: path.join(__dirname, 'bridge.js') });
}
`;
