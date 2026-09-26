import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathsDifferingFrom } from './git';
import { protectedPathsIn } from './publish-guard';

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const commit = (cwd: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', file);
};

describe('publish diff against the remote', () => {
  let tmp: string;
  let remote: string;
  let local: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubdiff-'));
    remote = path.join(tmp, 'remote.git');
    local = path.join(tmp, 'local');
    const seed = path.join(tmp, 'seed');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    git(tmp, 'init', '-q', '-b', 'main', seed);
    commit(seed, '.github/workflows/deploy.yml', 'v1');
    commit(seed, 'app.vue', 'a');
    git(seed, 'push', '-q', remote, 'main');
    git(tmp, 'clone', '-q', remote, local);
    // New Story updates the deploy workflow on the remote after the clone.
    commit(seed, '.github/workflows/deploy.yml', 'v2');
    git(seed, 'push', '-q', remote, 'main');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reports a protected file the remote changed, so a (force) push cannot revert it', () => {
    commit(local, 'app.vue', 'b'); // the customer only edits a page
    git(local, 'fetch', '-q', 'origin', 'main');
    const changed = pathsDifferingFrom(local, 'FETCH_HEAD');
    expect(changed).toContain('app.vue');
    expect(protectedPathsIn(changed)).toEqual(['.github/workflows/deploy.yml']);
  });

  it('is clean for a page edit on an up-to-date copy', () => {
    const pulled = git(local, 'pull', '-q', 'origin', 'main'); expect(pulled.status, pulled.stderr).toBe(0);
    commit(local, 'app.vue', 'b');
    git(local, 'fetch', '-q', 'origin', 'main');
    expect(protectedPathsIn(pathsDifferingFrom(local, 'FETCH_HEAD'))).toEqual([]);
  });
});
