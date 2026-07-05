// Dependency-free static file server for imported `static` projects.
import path from 'path';
import fs from 'fs/promises';

/**
 * Dependency-free static file server for imported `static` projects (a single
 * index.html + assets). Reads: argv[2]=port, argv[3]=host, argv[4]=root dir.
 * Serves the root dir, defaults directories to index.html, and falls back to
 * the root index.html for unknown paths (SPA-friendly). Lives OUTSIDE the
 * project so the repo stays pristine (the root comes in via argv, not __dirname).
 */
const STATIC_SERVER_SRC = `const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = parseInt(process.argv[2], 10) || 3000;
const HOST = process.argv[3] || '0.0.0.0';
const ROOT = path.resolve(process.argv[4] || '.');
// Optional backend sidecar: proxy these path prefixes to 127.0.0.1:PROXY_PORT.
const PROXY_PORT = parseInt(process.env.CLAUDABLE_PROXY_PORT || '', 10);
const PROXY_PREFIXES = (process.env.CLAUDABLE_PROXY_PREFIXES || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.webp':'image/webp', '.avif':'image/avif', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf', '.eot':'application/vnd.ms-fontobject', '.map':'application/json', '.txt':'text/plain', '.xml':'application/xml', '.wasm':'application/wasm', '.mp4':'video/mp4', '.webm':'video/webm', '.pdf':'application/pdf' };
function type(fp){ return TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream'; }
function serve(res, fp, status){
  fs.readFile(fp, function(e, data){
    if (e) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not found'); return; }
    res.writeHead(status || 200, {'Content-Type': type(fp), 'Cache-Control':'no-store'});
    res.end(data);
  });
}
function shouldProxy(p){
  if (!PROXY_PORT) return false;
  for (var i=0;i<PROXY_PREFIXES.length;i++){
    var pre = PROXY_PREFIXES[i];
    if (p === pre) return true;               // exact, e.g. /settings
    if (p.indexOf(pre + '/') === 0) return true; // under prefix, e.g. /api/...
  }
  return false;
}
function proxy(req, res){
  var opts = { host: '127.0.0.1', port: PROXY_PORT, method: req.method, path: req.url, headers: req.headers };
  var up = http.request(opts, function(pres){ res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); });
  up.on('error', function(){ if (!res.headersSent) res.writeHead(502, {'Content-Type':'text/plain'}); res.end('Bad gateway (backend not ready)'); });
  req.pipe(up);
}
const server = http.createServer(function(req, res){
  var urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { urlPath = '/'; }
  if (shouldProxy(urlPath)) return proxy(req, res);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  var filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, function(err, st){
    if (!err && st.isDirectory()) return serve(res, path.join(filePath, 'index.html'));
    if (!err && st.isFile()) return serve(res, filePath);
    return serve(res, path.join(ROOT, 'index.html'));
  });
});
server.listen(PORT, HOST, function(){ console.log('[static] ready on ' + HOST + ':' + PORT + ' serving ' + ROOT + (PROXY_PORT ? ' (proxy ' + PROXY_PREFIXES.join(',') + ' -> :' + PROXY_PORT + ')' : '')); });
`;

const STATIC_SERVER_PATH = path.join(process.cwd(), 'data', 'static-preview-server.cjs');
export async function ensureStaticServer(): Promise<string> {
  await fs.mkdir(path.dirname(STATIC_SERVER_PATH), { recursive: true });
  await fs.writeFile(STATIC_SERVER_PATH, STATIC_SERVER_SRC, 'utf8');
  return STATIC_SERVER_PATH;
}
