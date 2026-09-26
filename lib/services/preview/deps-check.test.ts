import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dropHiddenLockfile, missingDependencies } from './deps-check';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'depscheck-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function project(pkg: unknown, installed: string[] | null): string {
  const dir = fs.mkdtempSync(path.join(ROOT, 'p-'));
  fs.writeFileSync(path.join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  if (installed) {
    for (const n of installed) fs.mkdirSync(path.join(dir, 'node_modules', n), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  }
  return dir;
}

describe('missingDependencies', () => {
  it('reports a declared package that node_modules lacks (the pg case)', async () => {
    const dir = project({ dependencies: { nuxt: '^4', pg: '^8.23.0' }, devDependencies: { '@types/pg': '^8' } }, ['nuxt']);
    expect(await missingDependencies(dir)).toEqual(['pg', '@types/pg']);
  });

  it('is empty when complete, when node_modules is absent, or package.json is unreadable', async () => {
    expect(await missingDependencies(project({ dependencies: { vue: '^3', '@nuxt/ui': '^4' } }, ['vue', '@nuxt/ui']))).toEqual([]);
    expect(await missingDependencies(project({ dependencies: { vue: '^3' } }, null))).toEqual([]);
    expect(await missingDependencies(project('{not json', []))).toEqual([]);
  });

  it('accepts symlinked (file:/link:) deps and skips workspace specs and odd names', async () => {
    const dir = project({ dependencies: { local: 'file:../x', mono: 'workspace:*', '../evil': '1' } }, []);
    fs.symlinkSync(path.join(ROOT, 'nowhere'), path.join(dir, 'node_modules', 'local'));
    expect(await missingDependencies(dir)).toEqual([]);
  });

  it('never follows a symlinked package.json out of the project', async () => {
    const outside = path.join(ROOT, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ dependencies: { secret: '1' } }));
    const dir = project({}, []);
    fs.rmSync(path.join(dir, 'package.json'));
    fs.symlinkSync(outside, path.join(dir, 'package.json'));
    expect(await missingDependencies(dir)).toEqual([]);
  });
});

describe('dropHiddenLockfile', () => {
  it('removes node_modules/.package-lock.json only', async () => {
    const dir = project({}, []);
    fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    await dropHiddenLockfile(dir);
    expect(fs.existsSync(path.join(dir, 'node_modules', '.package-lock.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'package-lock.json'))).toBe(true);
  });
});
