import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('@/lib/services/client-log-token', () => ({ clientLogToken: () => 'tok' }));
const { previewPluginRelPath, ensurePreviewRouteReporter } = await import('./route-reporter');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('previewPluginRelPath', () => {
  it('uses app/plugins for a Nuxt 4 app/ source dir', () => {
    expect(previewPluginRelPath('export default defineNuxtConfig({})', true)).toBe('app/plugins/claudable-preview.client.ts');
    expect(previewPluginRelPath('export default defineNuxtConfig({})', false)).toBe('plugins/claudable-preview.client.ts');
  });
  it('keeps the root path when nuxt.config registers it explicitly', () => {
    expect(previewPluginRelPath("const P = 'plugins/claudable-preview.client.ts'", true)).toBe('plugins/claudable-preview.client.ts');
  });
  it('follows an explicit srcDir, refusing odd values', () => {
    expect(previewPluginRelPath("defineNuxtConfig({ srcDir: 'src/' })", false)).toBe('src/plugins/claudable-preview.client.ts');
    expect(previewPluginRelPath("defineNuxtConfig({ srcDir: '.' })", true)).toBe('plugins/claudable-preview.client.ts');
    expect(previewPluginRelPath("defineNuxtConfig({ srcDir: '../x' })", true)).toBe('plugins/claudable-preview.client.ts');
  });
});

describe('ensurePreviewRouteReporter', () => {
  it('writes into app/plugins, gitignores that path and removes our stale root copy', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'p-'));
    fs.writeFileSync(path.join(dir, 'nuxt.config.ts'), 'export default defineNuxtConfig({})');
    fs.mkdirSync(path.join(dir, 'app'));
    fs.writeFileSync(path.join(dir, 'app', 'app.vue'), '<template/>');
    fs.mkdirSync(path.join(dir, 'plugins'));
    fs.writeFileSync(path.join(dir, 'plugins', 'claudable-preview.client.ts'), '// Auto-added by Claudable (old)');
    fs.writeFileSync(path.join(dir, 'plugins', 'mine.ts'), 'keep');
    await ensurePreviewRouteReporter(dir, 'p');
    expect(fs.existsSync(path.join(dir, 'app', 'plugins', 'claudable-preview.client.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'plugins', 'claudable-preview.client.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'plugins', 'mine.ts'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('app/plugins/claudable-preview.client.ts');
  });
  it('never removes a root plugin file that is not ours', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'q-'));
    fs.writeFileSync(path.join(dir, 'nuxt.config.ts'), 'export default defineNuxtConfig({})');
    fs.mkdirSync(path.join(dir, 'app', 'pages'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'plugins'));
    fs.writeFileSync(path.join(dir, 'plugins', 'claudable-preview.client.ts'), '// someone else wrote this');
    await ensurePreviewRouteReporter(dir, 'q');
    expect(fs.readFileSync(path.join(dir, 'plugins', 'claudable-preview.client.ts'), 'utf8')).toBe('// someone else wrote this');
  });
});

describe('ensureDirInside', async () => {
  const { ensureDirInside } = await import('@/lib/utils/safe-fs');
  it('creates nothing outside the project through a symlinked ancestor', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'r-'));
    const outside = fs.mkdtempSync(path.join(ROOT, 'outside-'));
    fs.symlinkSync(outside, path.join(dir, 'app'));
    await expect(ensureDirInside(dir, path.join(dir, 'app', 'plugins'))).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('route reporting', () => {
  it('reports only the pathname (no query/hash such as the ?_ts= cache-buster)', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 's-'));
    fs.writeFileSync(path.join(dir, 'nuxt.config.ts'), 'export default defineNuxtConfig({})');
    await ensurePreviewRouteReporter(dir, 's');
    const src = fs.readFileSync(path.join(dir, 'plugins', 'claudable-preview.client.ts'), 'utf8');
    expect(src).not.toContain('fullPath');
    expect(src).toContain('postRoute(to.path)');
    expect(src).toContain('.split(/[?#]/)[0]');
  });
  it('rewrites an existing (older) plugin on every run so updates reach existing projects', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
    fs.writeFileSync(path.join(dir, 'nuxt.config.ts'), 'export default defineNuxtConfig({})');
    fs.mkdirSync(path.join(dir, 'plugins'));
    fs.writeFileSync(path.join(dir, 'plugins', 'claudable-preview.client.ts'), '// Auto-added by Claudable (old) postRoute(to.fullPath)');
    await ensurePreviewRouteReporter(dir, 't');
    expect(fs.readFileSync(path.join(dir, 'plugins', 'claudable-preview.client.ts'), 'utf8')).not.toContain('fullPath');
  });
});
