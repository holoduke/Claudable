import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { ensureStaticServer } from './static-server';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'static-bridge-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

async function withServer(env: Record<string, string>, fn: (base: string) => Promise<void>) {
  const site = fs.mkdtempSync(path.join(ROOT, 'site-'));
  fs.writeFileSync(path.join(site, 'index.html'), '<html><head><title>x</title></head><body>hi</body></html>');
  const port = await freePort();
  const child = spawn(process.execPath, [await ensureStaticServer(), String(port), '127.0.0.1', site], { env: { ...process.env, ...env }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i += 1) {
      if (await fetch(base).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await fn(base);
  } finally {
    child.kill();
  }
}

describe('static server preview bridge', () => {
  it('references and serves the bridge when CLAUDABLE_BRIDGE_FILE is set', async () => {
    const bridge = path.join(ROOT, 'bridge.js');
    fs.writeFileSync(bridge, '/* bridge */');
    await withServer({ CLAUDABLE_BRIDGE_FILE: bridge }, async (base) => {
      const html = await fetch(base).then((r) => r.text());
      expect(html.startsWith('<html><head><script src="/__claudable/bridge.js"></script><title>x</title>')).toBe(true);
      const js = await fetch(`${base}/__claudable/bridge.js`);
      expect(js.headers.get('cache-control')).toBe('no-store');
      expect(await js.text()).toBe('/* bridge */');
    });
  });
  it('leaves HTML alone without it', async () => {
    await withServer({ CLAUDABLE_BRIDGE_FILE: '' }, async (base) => {
      expect(await fetch(base).then((r) => r.text())).not.toContain('bridge.js');
    });
  });
});
