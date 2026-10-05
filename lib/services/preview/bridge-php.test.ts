import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BRIDGE_INJECT_PHP, bridgePhpIni } from './bridge-php';

const hasPhp = spawnSync('php', ['-v']).status === 0;
const BRIDGE = 'window.__claudableBridge=1;';

describe('bridgePhpIni', () => {
  it('points auto_prepend_file at inject.php in the mount', () => {
    expect(bridgePhpIni('/opt/claudable-bridge')).toContain('auto_prepend_file=/opt/claudable-bridge/inject.php');
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe.skipIf(!hasPhp)('BRIDGE_INJECT_PHP under php -S', () => {
  let dir = '';
  let base = '';
  let proc: ChildProcess | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-php-'));
    const bridgeDir = join(dir, 'bridge');
    const docroot = join(dir, 'www');
    mkdirSync(bridgeDir);
    mkdirSync(docroot);
    writeFileSync(join(bridgeDir, 'inject.php'), BRIDGE_INJECT_PHP);
    writeFileSync(join(bridgeDir, 'bridge.js'), BRIDGE);
    writeFileSync(join(docroot, 'page.php'), '<html><head><title>x</title></head><body>hi</body></html>');
    writeFileSync(join(docroot, 'nohead.php'), '<body class="a">hi</body>');
    writeFileSync(join(docroot, 'json.php'), '<?php header("Content-Type: application/json"); echo "{\\"a\\":\\"<head>\\"}";');
    writeFileSync(join(docroot, 'err.php'), '<?php http_response_code(500); ?><html><head></head></html>');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn('php', ['-d', `auto_prepend_file=${join(bridgeDir, 'inject.php')}`, '-S', `127.0.0.1:${port}`, '-t', docroot], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${base}/page.php`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  });

  afterAll(() => {
    proc?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('inlines the bridge right after <head>', async () => {
    const res = await fetch(`${base}/page.php`);
    expect(await res.text()).toBe(`<html><head><script>${BRIDGE}</script><title>x</title></head><body>hi</body></html>`);
    expect(res.headers.get('content-length')).toBeNull();
  });

  it('falls back to after <body> when there is no head', async () => {
    expect(await (await fetch(`${base}/nohead.php`)).text()).toBe(`<body class="a"><script>${BRIDGE}</script>hi</body>`);
  });

  it('leaves JSON and non-2xx responses untouched', async () => {
    expect(await (await fetch(`${base}/json.php`)).text()).toBe('{"a":"<head>"}');
    expect(await (await fetch(`${base}/err.php`)).text()).toBe('<html><head></head></html>');
  });

  it('is a no-op on the CLI', () => {
    const r = spawnSync('php', ['-d', `auto_prepend_file=${join(dir, 'bridge', 'inject.php')}`, '-r', 'echo "<head>cli";']);
    expect(r.stdout.toString()).toBe('<head>cli');
  });
});
