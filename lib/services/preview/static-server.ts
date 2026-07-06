// Dependency-free static file server for imported `static` projects.
import path from 'path';
import fs from 'fs/promises';

/**
 * Dependency-free static file server for imported `static` projects (a single
 * index.html + assets). Reads: argv[2]=port, argv[3]=host, argv[4]=root dir.
 * Serves the root dir, defaults directories to index.html, and falls back to
 * the root index.html for unknown paths (SPA-friendly). Lives OUTSIDE the
 * project so the repo stays pristine (the root comes in via argv, not __dirname).
 *
 * LIVE RELOAD: framework previews get HMR from their dev servers; static
 * projects had nothing — after an agent edit the iframe stayed stale until a
 * manual refresh. The server now exposes /__claudable/livereload (max mtime
 * over the project tree, throttled) and injects a small poller into served
 * HTML that reloads the page when that version changes.
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
// --- live reload: version = newest mtime across the tree (bounded walk, throttled) ---
var SKIP_DIRS = { 'node_modules':1, '.git':1, '.next':1, '.claudable':1, 'dist':1, '.cache':1 };
function walkMax(dir, depth, state){
  if (depth > 6 || state.n > 3000) return;
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (var i=0;i<entries.length;i++){
    var ent = entries[i];
    if (state.n++ > 3000) return;
    var fp = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (!SKIP_DIRS[ent.name]) walkMax(fp, depth+1, state); continue; }
    try { var m = fs.statSync(fp).mtimeMs; if (m > state.v) state.v = m; } catch (e) {}
  }
}
var lrCache = { v: 0, t: 0 };
function liveVersion(){
  var now = Date.now();
  if (now - lrCache.t < 500) return lrCache.v;
  var state = { v: 0, n: 0 };
  walkMax(ROOT, 0, state);
  lrCache = { v: state.v, t: now };
  return state.v;
}
var LR_SCRIPT = '<script>(function(){var v=null;setInterval(function(){fetch("/__claudable/livereload",{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){if(v===null){v=j.v;return;}if(j.v!==v){location.reload();}}).catch(function(){});},1500);})();</' + 'script>';
function serve(res, fp, status){
  fs.readFile(fp, function(e, data){
    if (e) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not found'); return; }
    var mime = type(fp);
    if (mime.indexOf('text/html') === 0) {
      var html = data.toString('utf8');
      var idx = html.lastIndexOf('</body>');
      html = idx >= 0 ? html.slice(0, idx) + LR_SCRIPT + html.slice(idx) : html + LR_SCRIPT;
      res.writeHead(status || 200, {'Content-Type': mime, 'Cache-Control':'no-store'});
      res.end(html);
      return;
    }
    res.writeHead(status || 200, {'Content-Type': mime, 'Cache-Control':'no-store'});
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
  if (urlPath === '/__claudable/livereload') {
    res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
    res.end(JSON.stringify({ v: liveVersion() }));
    return;
  }
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
