import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn, spawnSync } from 'child_process';

vi.mock('@/lib/services/client-log-token', () => ({ clientLogToken: () => 'tok' }));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-assets-'));
process.env.PROJECTS_DIR = path.join(ROOT, 'data', 'projects');
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const {
  BRIDGE_MOUNT, PHP_CONF_D_TARGET, adoptionNeedsBridgeRestart, bridgeDirFor, bridgeEnabledFor, bridgeGloballyEnabled, containerBridgeMode,
  containerBridgePlan, prepareContainerBridge, prepareStaticBridge, writeBridgeAssets,
} = await import('./bridge-assets');
const { BRIDGE_CONTAINER_PORT } = await import('./bridge-proxy');
const { enforcePreviewConfigPolicy } = await import('./config-policy');

const NODE_IMAGE = 'node:24-test';
const noLog = () => {};

describe('container bridge mode', () => {
  const base = { kind: 'next' as const, enabled: true, hasNuxtPlugin: false, usesDefaultNodeImage: true, effectivePort: 3100 };
  it('proxies node stacks (Next, Vite/React/Vue/Svelte imports, Angular) on the default image', () => {
    expect(containerBridgeMode(base)).toBe('proxy');
    expect(containerBridgeMode({ ...base, kind: 'angular' })).toBe('proxy');
    // An imported Vite app is stored with the legacy default kind 'nuxt' but has no nuxt.config.ts.
    expect(containerBridgeMode({ ...base, kind: 'nuxt' })).toBe('proxy');
  });
  it('leaves Nuxt to its plugin, and skips custom images / opt-outs', () => {
    expect(containerBridgeMode({ ...base, kind: 'nuxt', hasNuxtPlugin: true })).toBe('none');
    expect(containerBridgeMode({ ...base, usesDefaultNodeImage: false })).toBe('none');
    expect(containerBridgeMode({ ...base, enabled: false })).toBe('none');
    expect(containerBridgeMode({ ...base, effectivePort: BRIDGE_CONTAINER_PORT })).toBe('none');
  });
  it('uses PHP injection for Laravel (any image) unless disabled', () => {
    expect(containerBridgeMode({ ...base, kind: 'laravel', usesDefaultNodeImage: false })).toBe('php');
    expect(containerBridgeMode({ ...base, kind: 'laravel', enabled: false })).toBe('none');
  });
});

describe('container bridge plan (docker args / command)', () => {
  const dev = 'rm -rf .next/dev/lock 2>/dev/null; [ ! -f package.json ] || npm install; exec npm run dev -- --port 3100';
  it('proxy: publish → proxy port, read-only mount, proxy started before the unchanged dev script', () => {
    const p = containerBridgePlan('proxy', '/opt/claudable/data/.preview-bridge/projects/p1', 3100);
    expect(p.containerPort).toBe(BRIDGE_CONTAINER_PORT);
    expect(p.mountArgs).toEqual(['-v', `/opt/claudable/data/.preview-bridge/projects/p1:${BRIDGE_MOUNT}:ro`]);
    expect(p.env).toEqual({});
    expect(p.wrap(dev)).toBe(`node ${BRIDGE_MOUNT}/proxy.cjs ${BRIDGE_CONTAINER_PORT} 3100 & ${dev}`);
  });
  it('php: same port, mount + conf.d fragment, PHP_INI_SCAN_DIR appended (leading colon), script unchanged', () => {
    const p = containerBridgePlan('php', '/h/p1', 3100);
    expect(p.containerPort).toBe(3100);
    expect(p.mountArgs).toEqual(['-v', `/h/p1:${BRIDGE_MOUNT}:ro`, '-v', `/h/p1/php/claudable-bridge.ini:${PHP_CONF_D_TARGET}:ro`]);
    expect(p.env).toEqual({ PHP_INI_SCAN_DIR: `:${BRIDGE_MOUNT}/php` });
    expect(p.wrap('exec php artisan serve')).toBe('exec php artisan serve');
  });
  it('none: nothing changes', () => {
    const p = containerBridgePlan('none', '', 3100);
    expect(p).toMatchObject({ containerPort: 3100, mountArgs: [], env: {} });
    expect(p.wrap(dev)).toBe(dev);
  });
});

describe('prepareContainerBridge', () => {
  const project = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'proj-'));
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
    return dir;
  };
  const input = (projectPath: string, extra: Partial<Parameters<typeof prepareContainerBridge>[0]> = {}) => ({
    projectId: 'p1', projectPath, cfg: null, kind: 'next' as const, image: NODE_IMAGE, defaultNodeImage: NODE_IMAGE,
    effectivePort: 3100, toHostPath: (p: string) => p.replace(ROOT, '/host'), log: noLog, ...extra,
  });
  it('Nuxt with its plugin: unchanged (no mount, same port)', async () => {
    const r = await prepareContainerBridge(input(project({ 'nuxt.config.ts': '' }), { kind: 'nuxt' }));
    expect(r.mode).toBe('none');
    expect(r.mountArgs).toEqual([]);
    expect(r.containerPort).toBe(3100);
  });
  it('Next/Vite: writes the files and mounts the HOST path of the bridge dir', async () => {
    const r = await prepareContainerBridge(input(project({ 'package.json': '{}' })));
    expect(r.mode).toBe('proxy');
    expect(r.mountArgs[1]).toBe(`/host/data/.preview-bridge/projects/p1:${BRIDGE_MOUNT}:ro`);
    for (const f of ['bridge.js', 'proxy.cjs', 'inject.php', 'php/claudable-bridge.ini']) {
      expect(fs.existsSync(path.join(bridgeDirFor('p1'), f))).toBe(true);
    }
  });
  it('Laravel: PHP injection', async () => {
    const r = await prepareContainerBridge(input(project({}), { kind: 'laravel', image: 'webdevops/php:8.4' }));
    expect(r.mode).toBe('php');
    expect(r.env.PHP_INI_SCAN_DIR).toBe(`:${BRIDGE_MOUNT}/php`);
  });
  it('opt-outs: preview.json "bridge": false and PREVIEW_BRIDGE_PROXY=0', async () => {
    const dir = project({ 'package.json': '{}' });
    expect((await prepareContainerBridge(input(dir, { cfg: { bridge: false } }))).mode).toBe('none');
    process.env.PREVIEW_BRIDGE_PROXY = '0';
    try {
      expect((await prepareContainerBridge(input(dir))).mode).toBe('none');
      expect((await prepareContainerBridge(input(dir, { kind: 'laravel' }))).mode).toBe('none');
      expect(await prepareStaticBridge('p1', null, noLog)).toBeNull();
    } finally {
      delete process.env.PREVIEW_BRIDGE_PROXY;
    }
    expect(await prepareStaticBridge('p1', null, noLog)).toBe(path.join(bridgeDirFor('p1'), 'bridge.js'));
  });
  it('rejects unsafe project ids for paths', async () => {
    expect(() => bridgeDirFor('../x')).toThrow();
    const r = await prepareContainerBridge(input(project({ 'package.json': '{}' }), { projectId: '../evil' }));
    expect(r.mode).toBe('none');
  });
});

describe('opt-out parsing', () => {
  it('reads the global switch and the per-project flag', () => {
    expect(bridgeGloballyEnabled({})).toBe(true);
    for (const v of ['0', 'false', 'off', 'no']) expect(bridgeGloballyEnabled({ PREVIEW_BRIDGE_PROXY: v })).toBe(false);
    expect(bridgeGloballyEnabled({ PREVIEW_BRIDGE_PROXY: '1' })).toBe(true);
    expect(bridgeEnabledFor({ bridge: false }, {})).toBe(false);
    expect(bridgeEnabledFor({ bridge: true }, {})).toBe(true);
    expect(bridgeEnabledFor(null, {})).toBe(true);
  });
  it('policy keeps a boolean "bridge" and drops anything else', async () => {
    expect((await enforcePreviewConfigPolicy({ bridge: false }, ROOT, { customer: true })).cfg?.bridge).toBe(false);
    const r = await enforcePreviewConfigPolicy({ bridge: 'no' } as unknown as { bridge: boolean }, ROOT, { customer: false });
    expect(r.cfg && 'bridge' in r.cfg).toBe(false);
    expect(r.notes.join(' ')).toContain('bridge');
  });
});

// --- PHP prepend against the real built-in server (skipped without php) ---------------------

const hasPhp = spawnSync('php', ['-v']).status === 0;
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

describe.skipIf(!hasPhp)('inject.php (php -S)', () => {
  it('inlines the bridge into HTML only, and stays inert on the CLI', async () => {
    const bridgeDir = await writeBridgeAssets('php1');
    const docroot = fs.mkdtempSync(path.join(ROOT, 'php-'));
    fs.writeFileSync(path.join(docroot, 'page.php'), '<?php header("Content-Length: 40"); echo "<!doctype html><html><head><title>t</title></head><body>x</body></html>";');
    fs.writeFileSync(path.join(docroot, 'api.php'), '<?php header("Content-Type: application/json"); echo json_encode(["h" => "<head>"]);');
    fs.writeFileSync(path.join(docroot, 'err.php'), '<?php http_response_code(500); echo "<html><head></head></html>";');
    const cli = spawnSync('php', ['-d', `auto_prepend_file=${bridgeDir}/inject.php`, '-r', 'echo "cli-ok";']);
    expect(cli.stdout.toString()).toBe('cli-ok');

    const port = await freePort();
    const srv = spawn('php', ['-d', `auto_prepend_file=${bridgeDir}/inject.php`, '-S', `127.0.0.1:${port}`, '-t', docroot], { stdio: 'ignore' });
    try {
      let page = '';
      for (let i = 0; i < 50 && !page; i += 1) {
        page = await fetch(`http://127.0.0.1:${port}/page.php`).then((r) => r.text(), async () => { await new Promise((r) => setTimeout(r, 100)); return ''; });
      }
      expect(page.startsWith('<!doctype html><html><head><script>// Claudable preview bridge')).toBe(true);
      expect(page).toContain('</script><title>t</title>');
      expect(page).toContain('"p1"'.replace('p1', 'php1'));
      expect(await fetch(`http://127.0.0.1:${port}/api.php`).then((r) => r.text())).toBe('{"h":"<head>"}');
      expect(await fetch(`http://127.0.0.1:${port}/err.php`).then((r) => r.text())).toBe('<html><head></head></html>');
    } finally {
      srv.kill();
    }
  });
});

describe('adoptionNeedsBridgeRestart', () => {
  const base = { enabled: true, hasNuxtPlugin: false, customImage: false, containerMounts: ['/app'] };
  it('restarts a non-Nuxt preview that was started without the bridge mount', () => {
    expect(adoptionNeedsBridgeRestart(base)).toBe(true);
  });
  it('adopts when the mount is there, for Nuxt, custom images, or when the bridge is off', () => {
    expect(adoptionNeedsBridgeRestart({ ...base, containerMounts: ['/app', '/opt/claudable-bridge'] })).toBe(false);
    expect(adoptionNeedsBridgeRestart({ ...base, containerMounts: ['/opt/claudable-bridge/php'] })).toBe(false);
    expect(adoptionNeedsBridgeRestart({ ...base, hasNuxtPlugin: true })).toBe(false);
    expect(adoptionNeedsBridgeRestart({ ...base, customImage: true })).toBe(false);
    expect(adoptionNeedsBridgeRestart({ ...base, enabled: false })).toBe(false);
  });
});
