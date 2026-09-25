import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readFileInside, readTextInside, readTextInsideSync, realPathInside, writeFileInside, writeFileInsideSync } from './safe-fs';

describe('safe-fs (symlink-safe project file access)', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-fs-'));
    root = path.join(base, 'project');
    outside = path.join(base, 'secret.txt');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(outside, 'TOP SECRET');
    fs.writeFileSync(path.join(root, 'assets', 'ok.txt'), 'fine');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('reads a normal file inside the project', async () => {
    expect((await readFileInside(root, path.join(root, 'assets', 'ok.txt')))?.toString()).toBe('fine');
  });

  it('does not follow a symlink that points outside the project', async () => {
    fs.symlinkSync(outside, path.join(root, 'assets', 'x.png'));
    expect(await readFileInside(root, path.join(root, 'assets', 'x.png'))).toBeNull();
    expect(await realPathInside(root, path.join(root, 'assets', 'x.png'))).toBeNull();
  });

  it('does not read through a symlinked directory', async () => {
    fs.symlinkSync(base, path.join(root, 'linkdir'));
    expect(await readFileInside(root, path.join(root, 'linkdir', 'secret.txt'))).toBeNull();
  });

  it('refuses to write through a symlinked file', async () => {
    fs.symlinkSync(outside, path.join(root, 'assets', 'logo.png'));
    await expect(writeFileInside(root, path.join(root, 'assets', 'logo.png'), 'pwned')).rejects.toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe('TOP SECRET');
  });

  it('refuses to write into a symlinked directory', async () => {
    fs.rmSync(path.join(root, 'assets'), { recursive: true });
    fs.symlinkSync(base, path.join(root, 'assets'));
    await expect(writeFileInside(root, path.join(root, 'assets', 'new.png'), 'x')).rejects.toThrow(/outside/);
    expect(fs.existsSync(path.join(base, 'new.png'))).toBe(false);
  });

  it('writes a normal file inside the project', async () => {
    await writeFileInside(root, path.join(root, 'assets', 'sub', 'a.png'), 'data');
    expect(fs.readFileSync(path.join(root, 'assets', 'sub', 'a.png'), 'utf8')).toBe('data');
  });

  it('reads .gitignore text but refuses one that is a symlink out of the project', async () => {
    expect(await readTextInside(root, path.join(root, '.gitignore'))).toBe('');
    fs.symlinkSync(outside, path.join(root, '.gitignore'));
    await expect(readTextInside(root, path.join(root, '.gitignore'))).rejects.toThrow(/outside/);
    expect(() => readTextInsideSync(root, path.join(root, '.gitignore'))).toThrow(/outside/);
  });

  it('sync write refuses a symlinked target and a symlinked directory', () => {
    fs.symlinkSync(outside, path.join(root, 'ARCH.md'));
    expect(() => writeFileInsideSync(root, path.join(root, 'ARCH.md'), 'x')).toThrow();
    fs.symlinkSync(base, path.join(root, '.claudable'));
    expect(() => writeFileInsideSync(root, path.join(root, '.claudable', 'ARCHITECTURE.md'), 'x')).toThrow(/outside/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('TOP SECRET');
    expect(fs.existsSync(path.join(base, 'ARCHITECTURE.md'))).toBe(false);
  });

});
