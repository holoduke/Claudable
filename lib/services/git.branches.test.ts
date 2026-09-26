import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import {
  adoptBranchName, createLocalBranch, currentLocalBranch, fetchRemoteBranch, isValidBranchName,
  localBranchNames, pathsChangedSinceMergeBase, switchLocalBranch,
} from './git';

// The hardened git calls refuse the `file` transport (correct in production), so
// the test remote is served over git:// by a throwaway `git daemon`.
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const commit = (cwd: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', file);
};
const read = (cwd: string, file: string) => fs.readFileSync(path.join(cwd, file), 'utf8');

let root: string;
let daemon: ChildProcess;
let url: string;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => res(port));
    });
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'branches-'));
  const port = await freePort();
  daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--enable=receive-pack', `--base-path=${root}`, '--listen=127.0.0.1', `--port=${port}`, root], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((res) => {
      const c = net.connect(port, '127.0.0.1', () => { c.end(); res(true); }).on('error', () => res(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  url = `git://127.0.0.1:${port}/remote.git`;
});
afterAll(() => {
  daemon?.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

let local: string;
let seed: string;

beforeEach(() => {
  for (const d of ['remote.git', 'seed', 'local']) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  seed = path.join(root, 'seed');
  git(root, 'init', '-q', '-b', 'main', seed);
  commit(seed, 'app.vue', 'main-1');
  git(seed, 'push', '-q', path.join(root, 'remote.git'), 'main');
  git(seed, 'checkout', '-q', '-b', 'feature');
  commit(seed, 'feature.txt', 'f1');
  git(seed, 'push', '-q', path.join(root, 'remote.git'), 'feature');
  git(seed, 'checkout', '-q', 'main');
  local = path.join(root, 'local');
  git(root, 'clone', '-q', path.join(root, 'remote.git'), local);
  git(local, 'config', 'user.name', 'T');
  git(local, 'config', 'user.email', 't@example.com');
});

describe('isValidBranchName', () => {
  it('accepts normal names and rejects option-like / invalid refs', () => {
    for (const ok of ['main', 'feature/login', 'fix-1.2', 'v2_beta']) expect(isValidBranchName(ok), ok).toBe(true);
    for (const bad of ['-x', '--upload-pack=x', 'a..b', 'a b', 'x.lock', 'feat/', 'a~1', 'a^', 'a:b', '', '.hidden']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });
});

describe('switchLocalBranch', () => {
  it('checks out a remote-only branch as a local branch', () => {
    const r = switchLocalBranch(local, 'feature', url);
    expect(currentLocalBranch(local)).toBe('feature');
    expect(read(local, 'feature.txt')).toBe('f1');
    expect(r.changedFiles).toEqual(['feature.txt']);
  });

  it('keeps unpublished local commits when switching away and back (no reset)', () => {
    switchLocalBranch(local, 'feature', url);
    commit(local, 'feature.txt', 'local-only');
    switchLocalBranch(local, 'main', url);
    expect(fs.existsSync(path.join(local, 'feature.txt'))).toBe(false);
    switchLocalBranch(local, 'feature', url);
    expect(read(local, 'feature.txt')).toBe('local-only');
  });

  it('fast-forwards a local branch to what the remote gained', () => {
    switchLocalBranch(local, 'feature', url);
    switchLocalBranch(local, 'main', url);
    git(seed, 'checkout', '-q', 'feature');
    commit(seed, 'feature.txt', 'f2');
    git(seed, 'push', '-q', path.join(root, 'remote.git'), 'feature');
    const r = switchLocalBranch(local, 'feature', url);
    expect(read(local, 'feature.txt')).toBe('f2');
    expect(r.diverged).toBe(false);
  });

  it('reports divergence instead of discarding either side', () => {
    switchLocalBranch(local, 'feature', url);
    commit(local, 'mine.txt', 'mine');
    switchLocalBranch(local, 'main', url);
    git(seed, 'checkout', '-q', 'feature');
    commit(seed, 'theirs.txt', 'theirs');
    git(seed, 'push', '-q', path.join(root, 'remote.git'), 'feature');
    const r = switchLocalBranch(local, 'feature', url);
    expect(r.diverged).toBe(true);
    expect(read(local, 'mine.txt')).toBe('mine');
  });

  it('refuses a dirty tree and an unknown branch', () => {
    fs.writeFileSync(path.join(local, 'app.vue'), 'dirty');
    expect(() => switchLocalBranch(local, 'feature', url)).toThrow(/uncommitted/);
    git(local, 'checkout', '--', 'app.vue');
    expect(() => switchLocalBranch(local, 'nope', url)).toThrow(/does not exist/);
    expect(currentLocalBranch(local)).toBe('main');
  });
});

describe('createLocalBranch / adoptBranchName / fetchRemoteBranch', () => {
  it('creates a local-only branch from HEAD that the remote does not know yet', () => {
    commit(local, 'app.vue', 'wip');
    createLocalBranch(local, 'experiment');
    expect(currentLocalBranch(local)).toBe('experiment');
    expect(read(local, 'app.vue')).toBe('wip');
    expect(fetchRemoteBranch(local, 'experiment', url)).toBe(false);
    expect(fetchRemoteBranch(local, 'main', url)).toBe(true);
  });

  it('renames a legacy local branch to the branch it publishes to, never clobbering one', () => {
    git(local, 'branch', '-m', 'main', 'master');
    adoptBranchName(local, 'main');
    expect(currentLocalBranch(local)).toBe('main');
    git(local, 'branch', 'other');
    git(local, 'checkout', '-q', 'other');
    adoptBranchName(local, 'main'); // `main` exists → leave both alone
    expect(localBranchNames(local).sort()).toEqual(['main', 'other']);
  });

  it('throws (not "missing") when the remote is unreachable', () => {
    expect(() => fetchRemoteBranch(local, 'main', 'git://127.0.0.1:1/none.git')).toThrow();
  });
});

describe('pathsChangedSinceMergeBase', () => {
  it('lists only what the branch changed, not what the base gained meanwhile', () => {
    switchLocalBranch(local, 'feature', url);
    commit(local, 'page.vue', 'p');
    commit(seed, '.gitea/workflows/deploy.yml', 'base-only');
    git(seed, 'push', '-q', path.join(root, 'remote.git'), 'main');
    fetchRemoteBranch(local, 'main', url);
    expect(pathsChangedSinceMergeBase(local, 'FETCH_HEAD').sort()).toEqual(['feature.txt', 'page.vue']);
  });
});

describe('local-only repositories', () => {
  it('switches without any remote', () => {
    git(local, 'branch', 'feature', 'origin/feature');
    const r = switchLocalBranch(local, 'feature');
    expect(currentLocalBranch(local)).toBe('feature');
    expect(r.changedFiles).toEqual(['feature.txt']);
  });
});

describe('mergeLocalBranch', () => {
  it('merges into the target without touching the working tree', async () => {
    const { mergeLocalBranch } = await import('./git');
    createLocalBranch(local, 'work');
    commit(local, 'page.vue', 'new page');
    fs.writeFileSync(path.join(local, 'scratch.txt'), 'uncommitted'); // untouched by the merge
    const mtime = fs.statSync(path.join(local, 'app.vue')).mtimeMs;
    expect(mergeLocalBranch(local, 'work', 'main')).toBe('merged');
    expect(currentLocalBranch(local)).toBe('work');
    expect(git(local, 'show', 'main:page.vue').stdout).toBe('new page');
    expect(git(local, 'rev-list', '--parents', '-n', '1', 'main').stdout.split(' ').length).toBe(3); // real merge commit
    expect(fs.statSync(path.join(local, 'app.vue')).mtimeMs).toBe(mtime);
    expect(read(local, 'scratch.txt')).toBe('uncommitted');
    expect(mergeLocalBranch(local, 'work', 'main')).toBe('nothing');
  });

  it('aborts cleanly on a conflict: target untouched, source checked out again', async () => {
    const { mergeLocalBranch } = await import('./git');
    createLocalBranch(local, 'work');
    commit(local, 'app.vue', 'work-version');
    git(local, 'checkout', '-q', 'main');
    commit(local, 'app.vue', 'main-version');
    git(local, 'checkout', '-q', 'work');
    const mainBefore = git(local, 'rev-parse', 'main').stdout;
    expect(() => mergeLocalBranch(local, 'work', 'main')).toThrow(/Merge conflict.*app\.vue/);
    expect(currentLocalBranch(local)).toBe('work');
    expect(git(local, 'rev-parse', 'main').stdout).toBe(mainBefore);
    expect(git(local, 'status', '--porcelain').stdout).toBe('');
    expect(read(local, 'app.vue')).toBe('work-version');
  });
});
