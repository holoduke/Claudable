/**
 * Docker socket bind-mount filter (closes the audit's #7 gap).
 *
 * tecnativa/docker-socket-proxy filters by ENDPOINT but cannot inspect the
 * /containers/create body — so anyone reaching it could `docker run -v /:/h` and
 * gain host root. This tiny proxy sits IN FRONT of it: it transparently streams
 * every request through (including the attach/exec hijack and the build tar
 * upload), but for POST /containers/create it buffers the (tiny) JSON body and
 * rejects host bind mounts outside an allowlist, plus privileged / host-namespace
 * / device escapes.
 *
 * Allowlist = the host dirs Claudable legitimately bind-mounts: the data root
 * (project dirs, caches, agent homes — all via toHostPath → DATA_HOST_DIR) and
 * the optional skills/plugins host dirs. Named volumes and env-files (read
 * client-side by the docker CLI, never a bind) are unaffected.
 *
 * Staged rollout: SOCKET_FILTER_ENFORCE unset ⇒ LOG-ONLY (logs "WOULD BLOCK",
 * forwards). Set it to 1 to actually reject. FAILS OPEN on any internal error so
 * a filter bug can never break legitimate previews.
 */
'use strict';
const http = require('http');
const net = require('net');

const LISTEN_PORT = Number(process.env.LISTEN_PORT || 2375);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 2376);
const ENFORCE = process.env.SOCKET_FILTER_ENFORCE === '1';

const ALLOWED = [
  process.env.DATA_HOST_DIR,
  process.env.GLOBAL_SKILLS_HOST_DIR,
  process.env.AGENT_PLUGINS_HOST_DIR,
  ...(process.env.ALLOWED_BIND_PREFIXES || '').split(','),
]
  .map((s) => (s || '').trim().replace(/\/+$/, ''))
  .filter(Boolean);

const isCreate = (url) => /^\/(v[0-9.]+\/)?containers\/create(\?|$)/.test(url || '');

function bindSourceAllowed(src) {
  if (!src.startsWith('/')) return true; // named volume, not a host path
  if (!ALLOWED.length) return true; // misconfigured allowlist → never block (fail open)
  return ALLOWED.some((p) => src === p || src.startsWith(p + '/'));
}

// Returns a list of policy violations for a create body (empty = allowed).
function inspectCreate(bodyStr) {
  let json;
  try { json = JSON.parse(bodyStr); } catch { return []; } // unparseable → fail open
  const hc = json && json.HostConfig;
  if (!hc || typeof hc !== 'object') return [];
  const v = [];
  const binds = Array.isArray(hc.Binds) ? hc.Binds : [];
  for (const b of binds) {
    if (typeof b !== 'string') continue;
    const src = b.split(':')[0];
    if (src === '/var/run/docker.sock') v.push('docker.sock bind');
    else if (!bindSourceAllowed(src)) v.push(`bind:${src}`);
  }
  const mounts = Array.isArray(hc.Mounts) ? hc.Mounts : [];
  for (const m of mounts) {
    if (m && m.Type === 'bind' && typeof m.Source === 'string' && !bindSourceAllowed(m.Source)) {
      v.push(`mount:${m.Source}`);
    }
  }
  if (hc.Privileged === true) v.push('privileged');
  if (hc.PidMode === 'host') v.push('pid=host');
  if (hc.IpcMode === 'host') v.push('ipc=host');
  if (hc.UsernsMode === 'host') v.push('userns=host');
  if (Array.isArray(hc.Devices) && hc.Devices.length) v.push('devices');
  if (Array.isArray(hc.CapAdd) && hc.CapAdd.length) v.push(`capAdd:${hc.CapAdd.join(',')}`);
  return v;
}

const server = http.createServer((req, res) => {
  const forward = (bodyBuf) => {
    const upReq = http.request(
      { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers: req.headers },
      (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); },
    );
    upReq.on('error', () => { try { res.writeHead(502); res.end('socket-filter upstream error'); } catch {} });
    if (bodyBuf !== undefined) upReq.end(bodyBuf);
    else req.pipe(upReq);
  };

  if (req.method === 'POST' && isCreate(req.url)) {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > 2 * 1024 * 1024) tooBig = true; else chunks.push(c); });
    req.on('error', () => forward(undefined));
    req.on('end', () => {
      if (tooBig) return forward(undefined); // create bodies are tiny; oversized → can't inspect, fail open
      const body = Buffer.concat(chunks);
      let violations = [];
      try { violations = inspectCreate(body.toString('utf8')); } catch { violations = []; }
      if (violations.length) {
        console.error(`[socket-filter] ${ENFORCE ? 'BLOCKED' : 'WOULD BLOCK'} create: ${violations.join('; ')}`);
        if (ENFORCE) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: `socket-filter denied create: ${violations.join('; ')}` }));
        }
      }
      forward(body);
    });
  } else {
    forward(undefined);
  }
});

// docker attach/exec use an HTTP Upgrade (tcp hijack) — proxy the raw socket.
server.on('upgrade', (req, clientSocket, head) => {
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[socket-filter] listening :${LISTEN_PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT} enforce=${ENFORCE} allow=[${ALLOWED.join(', ')}]`);
});
