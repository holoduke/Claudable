import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lockcache-test-'));
process.env.PROJECTS_DIR = path.join(ROOT, 'data', 'projects');
const CACHE = path.join(ROOT, 'data', '.lock-cache');

const { depsKey, lockResolvesOnlyFromRegistry, seedLockfile, sharedNpmCacheDir, npmInstallEnv } = await import('./lockfile-cache');

const pkg = { name: 'tmpl', version: '0.1.0', dependencies: { nuxt: '^4.5.2', vue: '^3.5.0' }, devDependencies: { typescript: '~6.0.3' } };
const goodLock = {
  name: 'tmpl', version: '0.1.0', lockfileVersion: 3,
  packages: {
    '': { name: 'tmpl', version: '0.1.0' },
    'node_modules/vue': { version: '3.5.43', resolved: 'https://registry.npmjs.org/vue/-/vue-3.5.43.tgz', integrity: 'sha512-x' },
  },
};

function project(name: string, files: Record<string, unknown> = {}) {
  const dir = path.join(ROOT, 'data', 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, name }));
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(dir, f);
    if (c === 'DIR') fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, typeof c === 'string' ? c : JSON.stringify(c));
  }
  return dir;
}

beforeEach(() => {
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, `${depsKey(pkg)}.json`), JSON.stringify(goodLock));
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('depsKey', () => {
  it('ignores name/version/scripts and key order, but not versions', () => {
    const a = depsKey({ ...pkg, name: 'x', scripts: { dev: 'nuxt dev' } });
    const b = depsKey({ devDependencies: pkg.devDependencies, dependencies: { vue: '^3.5.0', nuxt: '^4.5.2' } });
    expect(a).toBe(b);
    expect(depsKey({ ...pkg, dependencies: { ...pkg.dependencies, vue: '^3.6.0' } })).not.toBe(a);
  });
});

describe('lockResolvesOnlyFromRegistry', () => {
  it('rejects lockfiles that resolve anywhere but the public npm registry', () => {
    expect(lockResolvesOnlyFromRegistry(goodLock)).toBe(true);
    const evil = structuredClone(goodLock) as any;
    evil.packages['node_modules/vue'].resolved = 'https://evil.example/vue.tgz';
    expect(lockResolvesOnlyFromRegistry(evil)).toBe(false);
    const git = structuredClone(goodLock) as any;
    git.packages['node_modules/vue'].resolved = 'git+ssh://git@github.com/x/y.git';
    expect(lockResolvesOnlyFromRegistry(git)).toBe(false);
    expect(lockResolvesOnlyFromRegistry({} as any)).toBe(false);
  });
});

describe('seedLockfile', () => {
  it('seeds a matching template lockfile with the project name', async () => {
    const dir = project('fresh');
    expect(await seedLockfile(dir)).toBe(true);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    expect(lock.name).toBe('fresh');
    expect(lock.packages[''].name).toBe('fresh');
    expect(lock.packages['node_modules/vue'].version).toBe('3.5.43');
  });

  it('never overwrites or competes with an existing lockfile / node_modules', async () => {
    expect(await seedLockfile(project('has-lock', { 'package-lock.json': { name: 'own' } }))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/projects/has-lock/package-lock.json'), 'utf8')).name).toBe('own');
    expect(await seedLockfile(project('pnpm', { 'pnpm-lock.yaml': 'lockfileVersion: 9' }))).toBe(false);
    expect(await seedLockfile(project('installed', { node_modules: 'DIR' }))).toBe(false);
  });

  it('does nothing when the dependencies differ from every template', async () => {
    const dir = project('custom');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'custom', dependencies: { lodash: '^4' } }));
    expect(await seedLockfile(dir)).toBe(false);
  });

  it('refuses a cached lockfile that was tampered with', async () => {
    const evil = structuredClone(goodLock) as any;
    evil.packages['node_modules/vue'].resolved = 'https://evil.example/vue.tgz';
    fs.writeFileSync(path.join(CACHE, `${depsKey(pkg)}.json`), JSON.stringify(evil));
    const dir = project('victim');
    expect(await seedLockfile(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'package-lock.json'))).toBe(false);
  });
});

describe('npm env', () => {
  it('uses the persistent shared cache under the data dir and quiet flags', () => {
    const env = npmInstallEnv({ PATH: '/bin' });
    expect(env.npm_config_cache).toBe(sharedNpmCacheDir());
    expect(sharedNpmCacheDir()).toBe(path.join(ROOT, 'data', '.npm-cache'));
    expect(env.npm_config_prefer_offline).toBeUndefined(); // stale shared metadata → ETARGET
    expect(env.npm_config_audit).toBe('false');
  });
});
