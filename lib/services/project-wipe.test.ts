import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---- sandbox layout (paths are read at module load, so set env/cwd first) ----
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-test-'));
const DATA = path.join(ROOT, 'data');
const PROJECTS = path.join(DATA, 'projects');
const ROUTES = path.join(ROOT, 'traefik');
process.env.PROJECTS_DIR = PROJECTS;
process.env.THUMBNAILS_DIR = path.join(DATA, 'thumbnails');
process.env.TRAEFIK_DYNAMIC_DIR = ROUTES;
vi.spyOn(process, 'cwd').mockReturnValue(ROOT);

// ---- in-memory prisma --------------------------------------------------------
type Row = { id: string; name: string; repoPath: string | null; orgId: string | null };
const db = {
  projects: [] as Row[],
  connections: [] as { projectId: string; provider: string; serviceData: string }[],
};
vi.mock('@/lib/db/client', () => ({
  prisma: {
    project: {
      findUnique: async ({ where }: any) => db.projects.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where }: any = {}) =>
        db.projects.filter((p) => !where?.id?.not || p.id !== where.id.not),
      delete: async ({ where }: any) => {
        db.projects = db.projects.filter((p) => p.id !== where.id);
        db.connections = db.connections.filter((c) => c.projectId !== where.id);
      },
    },
    projectServiceConnection: {
      findMany: async ({ where }: any) =>
        db.connections.filter((c) =>
          (!where.provider || c.provider === where.provider)
          && (!where.projectId || (typeof where.projectId === 'string' ? c.projectId === where.projectId : c.projectId !== where.projectId.not))),
    },
    designCanvas: { findMany: async () => [] },
  },
}));
vi.mock('./managed-containers', () => ({ getServices: async () => [] }));
vi.mock('./audit', () => ({ recordAudit: vi.fn(async () => {}) }));
const stopMock = vi.fn(async () => ({}));
vi.mock('./preview', () => ({
  previewManager: { stop: stopMock, getStatus: () => ({ status: 'stopped' }) },
}));
vi.mock('./cli/run-registry', () => ({ interruptAgentRun: vi.fn(() => ({ interrupted: false })) }));
const deleteRepoMock = vi.fn(async () => 'ok');
vi.mock('./itops/gitea-admin-ops', () => ({ deleteRepo: deleteRepoMock }));
vi.mock('./git-provider', () => ({
  getGitProviderConfig: () => ({ org: 'managed-org', provider: 'gitea' }),
  getGitProviderConfigFor: () => ({ provider: 'gitea' }),
}));
// never shell out to a real docker daemon from a unit test
vi.mock('child_process', () => ({
  spawn: () => {
    const handlers: Record<string, (...a: any[]) => void> = {};
    const proc: any = {
      stdout: { on: () => {} },
      on: (ev: string, cb: any) => { handlers[ev] = cb; if (ev === 'exit') setTimeout(() => cb(1), 0); return proc; },
      kill: () => {},
    };
    return proc;
  },
}));

let wipe: typeof import('./project-wipe');

function touch(p: string, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeAll(async () => {
  wipe = await import('./project-wipe');
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(ROUTES, { recursive: true, force: true });
  db.projects = [];
  db.connections = [];
  stopMock.mockClear();
  deleteRepoMock.mockClear();
});

function seed(id: string, extra: Partial<Row> = {}) {
  db.projects.push({ id, name: `Name ${id}`, repoPath: path.join(PROJECTS, id), orgId: null, ...extra });
  touch(path.join(PROJECTS, id, 'index.html'));
  touch(path.join(DATA, 'agent-homes', id, 'session.jsonl'));
  touch(path.join(DATA, 'checkpoints', id, 'HEAD'));
  touch(path.join(DATA, 'thumbnails', `${id}.webp`));
}

describe('pure helpers', () => {
  it('isStrictlyInside', () => {
    expect(wipe.isStrictlyInside('/a/b', '/a/b/c')).toBe(true);
    expect(wipe.isStrictlyInside('/a/b', '/a/b')).toBe(false);
    expect(wipe.isStrictlyInside('/a/b', '/a/bc')).toBe(false);
    expect(wipe.isStrictlyInside('/a/b', '/a/b/../c')).toBe(false);
  });
  it('detects runtime-name collisions (case and -api backend)', () => {
    expect([...wipe.sharedRuntimeNames('Foo', ['foo'])].length).toBeGreaterThan(0);
    expect(wipe.sharedRuntimeNames('x-api', ['x']).has('claudable-preview-x-api')).toBe(true);
    expect(wipe.sharedRuntimeNames('alpha', ['alpha-2', 'beta']).size).toBe(0);
  });
  it('agent container pattern matches only this project', () => {
    const re = wipe.projectRuntimeNames('shop').agentContainerRe;
    expect(re.test('claudable-agent-shop-0123abcd')).toBe(true);
    expect(re.test('claudable-agent-shop-2-0123abcd')).toBe(false);
    expect(re.test('claudable-agent-shopx-0123abcd')).toBe(false);
  });
});

describe('wipeProject isolation', () => {
  it('removes everything of the project and nothing of a same-prefix neighbour', async () => {
    seed('shop');
    seed('shop-2');
    touch(path.join(ROUTES, 'preview-shop.yml'), '# claudable-managed-preview\nx');
    touch(path.join(ROUTES, 'preview-shop-2.yml'), '# claudable-managed-preview\nx');
    touch(path.join(ROUTES, 'preview-shop-api.yml'), 'not ours\n');

    const report = await wipe.wipeProject('shop');

    expect(fs.existsSync(path.join(PROJECTS, 'shop'))).toBe(false);
    expect(fs.existsSync(path.join(DATA, 'agent-homes', 'shop'))).toBe(false);
    expect(fs.existsSync(path.join(DATA, 'checkpoints', 'shop'))).toBe(false);
    expect(fs.existsSync(path.join(DATA, 'thumbnails', 'shop.webp'))).toBe(false);
    expect(fs.existsSync(path.join(ROUTES, 'preview-shop.yml'))).toBe(false);
    expect(db.projects.map((p) => p.id)).toEqual(['shop-2']);
    // the neighbour is untouched
    expect(fs.existsSync(path.join(PROJECTS, 'shop-2', 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(DATA, 'agent-homes', 'shop-2'))).toBe(true);
    expect(fs.existsSync(path.join(DATA, 'checkpoints', 'shop-2'))).toBe(true);
    expect(fs.existsSync(path.join(DATA, 'thumbnails', 'shop-2.webp'))).toBe(true);
    expect(fs.existsSync(path.join(ROUTES, 'preview-shop-2.yml'))).toBe(true);
    // a route file without our marker is never deleted
    expect(fs.existsSync(path.join(ROUTES, 'preview-shop-api.yml'))).toBe(true);
    expect(report.failed).toEqual([]);
  });

  it('never deletes a repoPath outside the projects directory', async () => {
    const outside = path.join(ROOT, 'elsewhere', 'important');
    touch(path.join(outside, 'keep.txt'));
    seed('evil', { repoPath: outside });
    const plan = await wipe.planWipe('evil');
    expect(plan.paths).not.toContain(outside);
    expect(plan.skipped.some((s) => s.what.includes(outside))).toBe(true);
    await wipe.wipeProject('evil');
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });

  it('never deletes a repoPath shared with another project', async () => {
    seed('a');
    seed('b', { repoPath: path.join(PROJECTS, 'a') });
    await wipe.wipeProject('b');
    expect(fs.existsSync(path.join(PROJECTS, 'a', 'index.html'))).toBe(true);
    expect(db.projects.map((p) => p.id)).toEqual(['a']);
  });

  it('unlinks a symlinked project folder without touching its target', async () => {
    seed('victim');
    db.projects.push({ id: 'linky', name: 'Name linky', repoPath: path.join(PROJECTS, 'linky'), orgId: null });
    fs.symlinkSync(path.join(PROJECTS, 'victim'), path.join(PROJECTS, 'linky'));
    await wipe.wipeProject('linky');
    expect(fs.existsSync(path.join(PROJECTS, 'linky'))).toBe(false);
    expect(fs.existsSync(path.join(PROJECTS, 'victim', 'index.html'))).toBe(true);
  });

  it('skips runtime resources whose names collide with another project', async () => {
    seed('Foo');
    seed('foo');
    touch(path.join(ROUTES, 'preview-foo.yml'), '# claudable-managed-preview\nx');
    const plan = await wipe.planWipe('Foo');
    expect(plan.containers).toEqual([]);
    expect(plan.routeFiles).toEqual([]);
    expect(plan.network).toBeNull();
    await wipe.wipeProject('Foo');
    expect(stopMock).not.toHaveBeenCalled(); // stop() would remove the shared route
    expect(fs.existsSync(path.join(ROUTES, 'preview-foo.yml'))).toBe(true);
  });

  it('only deletes a remote repo from the managed org and never a shared one', async () => {
    seed('p1');
    seed('p2');
    db.connections.push({ projectId: 'p1', provider: 'github', serviceData: JSON.stringify({ owner: 'someone-else', repo_name: 'r' }) });
    expect((await wipe.planWipe('p1')).remoteRepo?.deletable).toBe(false);
    await wipe.wipeProject('p1', { deleteRemoteRepo: true });
    expect(deleteRepoMock).not.toHaveBeenCalled();

    db.connections.push({ projectId: 'p2', provider: 'github', serviceData: JSON.stringify({ owner: 'managed-org', repo_name: 'shared' }) });
    seed('p3');
    db.connections.push({ projectId: 'p3', provider: 'github', serviceData: JSON.stringify({ owner: 'managed-org', repo_name: 'shared' }) });
    expect((await wipe.planWipe('p2')).remoteRepo?.deletable).toBe(false);

    seed('p4');
    db.connections.push({ projectId: 'p4', provider: 'github', serviceData: JSON.stringify({ owner: 'managed-org', repo_name: 'own' }) });
    await wipe.wipeProject('p4', { deleteRemoteRepo: true });
    expect(deleteRepoMock).toHaveBeenCalledWith('own', 'managed-org');
  });

  it('rejects ids that are not safe path segments', async () => {
    await expect(wipe.planWipe('../etc')).rejects.toThrow('Invalid project id');
  });
});
