import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbranches-'));
let repoPath = '';
let agentBusy = false;
const preview = { status: 'running', stop: vi.fn(async () => {}), start: vi.fn(async () => ({})), installDependencies: vi.fn(async () => {}) };

vi.mock('@/lib/services/project', () => ({ getProjectById: async () => ({ id: 'p', repoPath }) }));
vi.mock('@/lib/services/project-services', () => ({ getProjectService: async () => null, updateProjectServiceData: async () => {} }));
vi.mock('@/lib/services/cli/run-registry', () => ({ isAgentRunActive: () => agentBusy }));
vi.mock('@/lib/services/tenant-policy', () => ({ isCustomerProject: async () => false }));
vi.mock('@/lib/services/git-provider', () => ({ getGitProviderConfigFor: () => ({}) }));
vi.mock('@/lib/services/preview', () => ({
  previewManager: {
    getStatus: () => ({ status: preview.status }),
    stop: preview.stop, start: preview.start, installDependencies: preview.installDependencies,
  },
}));
vi.mock('@/lib/services/github', () => {
  class GitHubError extends Error { constructor(m: string, readonly status?: number) { super(m); } }
  return {
    GitHubError,
    withGitLock: (_id: string, fn: () => Promise<unknown>) => fn(),
    ensureProjectRepository: async (_id: string, p: string) => p,
    projectGitBranch: (d: any) => d?.branch ?? 'main',
    projectBaseBranch: (d: any) => d?.base_branch ?? 'main',
    getGithubUser: async () => ({}), githubFetch: async () => [], resolveGitToken: async () => '',
    mergePublishPr: async () => 'merged', pushProjectToGitHub: async () => true,
  };
});

const svc = await import('./git-branches');
const git = (...args: string[]) => spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' }).stdout.trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repoPath, f), c);

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(ROOT, 'p-'));
  agentBusy = false;
  preview.status = 'running';
  vi.clearAllMocks();
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('ensureLocalGit', () => {
  it('waits for content, then creates a repo on main with everything committed', async () => {
    expect(await svc.ensureLocalGit('p')).toBe(false);
    expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(false);
    write('index.html', 'hi');
    expect(await svc.ensureLocalGit('p')).toBe(true);
    expect(git('branch', '--show-current')).toBe('main');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('show', 'HEAD:index.html')).toBe('hi');
  });

  it('keeps build output out of the first commit without touching .gitignore', async () => {
    write('index.html', 'hi');
    fs.mkdirSync(path.join(repoPath, '.nuxt'));
    write('.nuxt/big.js', 'x');
    fs.writeFileSync(path.join(repoPath, '.gitignore'), 'custom\n');
    await svc.ensureLocalGit('p');
    expect(git('ls-files')).not.toContain('.nuxt/');
    expect(fs.readFileSync(path.join(repoPath, '.gitignore'), 'utf8')).toContain('custom');
  });
});

describe('local branches', () => {
  beforeEach(async () => {
    write('index.html', 'v1');
    await svc.ensureLocalGit('p');
  });

  it('creates a branch, keeping pending work on the branch it was made on', async () => {
    write('index.html', 'pending on main');
    await svc.createProjectBranch('p', 'feature/x');
    expect(git('branch', '--show-current')).toBe('feature/x');
    expect(git('show', 'main:index.html')).toBe('pending on main');
    const list = await svc.listProjectBranches('p');
    expect(list.mode).toBe('local');
    expect(list.current).toBe('feature/x');
    expect(list.base).toBe('main');
    expect(list.branches.map((b) => b.name)).toEqual(['main', 'feature/x']);
  });

  it('switches back and forth without losing work, restarting the preview only on change', async () => {
    await svc.createProjectBranch('p', 'work');
    write('page.vue', 'new page');
    const toMain = await svc.switchProjectBranch('p', 'main');
    expect(toMain.changed_files).toBe(1);
    expect(fs.existsSync(path.join(repoPath, 'page.vue'))).toBe(false);
    expect(preview.stop).toHaveBeenCalledTimes(1);
    expect(preview.start).toHaveBeenCalledTimes(1);
    await svc.switchProjectBranch('p', 'work');
    expect(fs.readFileSync(path.join(repoPath, 'page.vue'), 'utf8')).toBe('new page');
    preview.stop.mockClear();
    const same = await svc.switchProjectBranch('p', 'work');
    expect(same.changed_files).toBe(0);
    expect(preview.stop).not.toHaveBeenCalled();
  });

  it('reinstalls dependencies when a manifest differs between branches', async () => {
    await svc.createProjectBranch('p', 'deps');
    write('package.json', '{"dependencies":{"x":"1"}}');
    const r = await svc.switchProjectBranch('p', 'main');
    expect(r.dependencies_changed).toBe(true);
    expect(preview.installDependencies).toHaveBeenCalledWith('p', { force: true });
  });

  it('merges the current branch into main and stays on it', async () => {
    await svc.createProjectBranch('p', 'work');
    write('page.vue', 'new page');
    const r = await svc.mergeProjectBranchIntoBase('p');
    expect(r).toMatchObject({ merged: true, branch: 'work', base: 'main', mode: 'local' });
    expect(git('branch', '--show-current')).toBe('work');
    expect(git('show', 'main:page.vue')).toBe('new page');
    await expect(svc.switchProjectBranch('p', 'main')).resolves.toBeTruthy();
    await expect(svc.mergeProjectBranchIntoBase('p')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses while the agent is working, bad names and duplicates', async () => {
    agentBusy = true;
    await expect(svc.createProjectBranch('p', 'x')).rejects.toMatchObject({ status: 409 });
    await expect(svc.switchProjectBranch('p', 'main')).rejects.toMatchObject({ status: 409 });
    agentBusy = false;
    await expect(svc.createProjectBranch('p', '--upload-pack=evil')).rejects.toMatchObject({ status: 400 });
    await expect(svc.createProjectBranch('p', 'main')).rejects.toMatchObject({ status: 409 });
    await expect(svc.switchProjectBranch('p', 'nope')).rejects.toMatchObject({ status: 404 });
    expect(git('branch', '--show-current')).toBe('main');
  });
});
