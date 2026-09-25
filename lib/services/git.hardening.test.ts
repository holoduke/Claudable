import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { assertSafeGitRepository, commitAll } from './git';

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

describe('git hardening against project-controlled .git', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hard-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('accepts a repository with plain config', () => {
    git(repo, 'remote', 'add', 'origin', 'https://example.com/repo.git');
    expect(() => assertSafeGitRepository(repo)).not.toThrow();
  });

  it.each([
    ['core.fsmonitor', 'touch /tmp/pwned'],
    ['filter.evil.clean', 'touch /tmp/pwned'],
    ['include.path', '../evil.config'],
    ['url.https://attacker.example/.insteadOf', 'https://github.com/'],
    ['core.hooksPath', '.githooks'],
    ['remote.origin.pushurl', 'https://attacker.example/x.git'],
  ])('refuses %s', (key, value) => {
    git(repo, 'config', key, value);
    expect(() => assertSafeGitRepository(repo)).toThrow(/unsafe setting/);
  });

  it('refuses a .git file that points at another repository', () => {
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /somewhere/else/.git\n');
    expect(() => assertSafeGitRepository(repo)).toThrow(/not a plain directory/);
  });

  it('refuses object alternates', () => {
    fs.mkdirSync(path.join(repo, '.git', 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), '/other/repo/.git/objects\n');
    expect(() => assertSafeGitRepository(repo)).toThrow(/alternates/);
  });

  it('never runs hooks the project planted', () => {
    const marker = path.join(repo, 'hook-ran');
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    commitAll(repo, 'test');
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(repo, 'log', '--oneline').stdout).toContain('test');
  });
});
