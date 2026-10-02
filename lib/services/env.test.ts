import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// The Envs tab must never wipe keys that only exist in the project's .env
// (DATABASE_URL, API keys written by the agent/import). Prisma, crypto and the
// project lookup are mocked; the .env is a real file in a temp dir.
type Row = { id: string; projectId: string; key: string; valueEncrypted: string; scope: string; varType: string; isSecret: boolean; description: string | null };
const rows: Row[] = [];
let repoDir = '';

const byKey = (where: any) => rows.find((r) => r.projectId === where.projectId_key.projectId && r.key === where.projectId_key.key);

vi.mock('@/lib/db/client', () => ({
  prisma: {
    envVar: {
      findMany: vi.fn(async ({ where }: any) => rows.filter((r) => r.projectId === where.projectId).sort((a, b) => a.key.localeCompare(b.key))),
      findUnique: vi.fn(async ({ where }: any) => byKey(where) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row: Row = { id: `id-${data.key}`, scope: 'runtime', varType: 'string', isSecret: true, description: null, ...data };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(byKey(where)!, data)),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const hit = byKey(where);
        if (hit) return Object.assign(hit, update);
        const row: Row = { id: `id-${create.key}`, description: null, ...create };
        rows.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i].projectId === where.projectId && rows[i].key === where.key) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
    },
  },
}));
vi.mock('@/lib/crypto', () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') }));
vi.mock('@/lib/services/project', () => ({
  getProjectById: vi.fn(async (id: string) => ({ id, repoPath: repoDir })),
}));

import { createEnvVar, deleteEnvVar, listEnvVarsForSettings, syncDbToEnvFile, updateEnvVar } from './env';

const AGENT_ENV = '# from the agent\nDATABASE_URL=postgres://u:p@db/app?x=1\n\nOPENAI_KEY="sk-abc"\n';
const envPath = () => path.join(repoDir, '.env');
const readEnv = () => fs.readFile(envPath(), 'utf8');

beforeEach(async () => {
  rows.length = 0;
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-test-'));
  await fs.writeFile(envPath(), AGENT_ENV, 'utf8');
});

afterEach(async () => {
  await fs.rm(repoDir, { recursive: true, force: true });
});

describe('env service keeps file-only keys', () => {
  it('lists file-only keys alongside DB keys', async () => {
    await createEnvVar('p1', { key: 'APP_NAME', value: 'demo', isSecret: false });
    const list = await listEnvVarsForSettings('p1');
    expect(list.map((r) => [r.key, r.source])).toEqual([
      ['APP_NAME', 'db'],
      ['DATABASE_URL', 'file'],
      ['OPENAI_KEY', 'file'],
    ]);
    expect(list.find((r) => r.key === 'OPENAI_KEY')).toMatchObject({ value: 'sk-abc', is_secret: true });
  });

  it('adding a var appends it without touching the rest of the file', async () => {
    await createEnvVar('p1', { key: 'APP_NAME', value: 'has space' });
    expect(await readEnv()).toBe(`${AGENT_ENV}APP_NAME='has space'\n`);
  });

  it('editing a file-only key adopts it into the DB and rewrites only that line', async () => {
    expect(await updateEnvVar('p1', 'OPENAI_KEY', 'sk-new')).toBe(true);
    expect(rows.map((r) => r.key)).toEqual(['OPENAI_KEY']);
    expect(await readEnv()).toBe('# from the agent\nDATABASE_URL=postgres://u:p@db/app?x=1\n\nOPENAI_KEY=sk-new\n');
  });

  it('editing an unknown key is still a not-found', async () => {
    expect(await updateEnvVar('p1', 'NOPE', 'x')).toBe(false);
  });

  it('deleting removes just that key (DB or file-only)', async () => {
    expect(await deleteEnvVar('p1', 'OPENAI_KEY')).toBe(true);
    expect(await readEnv()).toBe('# from the agent\nDATABASE_URL=postgres://u:p@db/app?x=1\n\n');
    expect(await deleteEnvVar('p1', 'OPENAI_KEY')).toBe(false);
  });

  it('db-to-file sync merges: DB values win, file-only keys survive', async () => {
    rows.push({ id: 'x', projectId: 'p1', key: 'OPENAI_KEY', valueEncrypted: 'enc:sk-db', scope: 'runtime', varType: 'string', isSecret: true, description: null });
    expect(await syncDbToEnvFile('p1')).toBe(1);
    const out = await readEnv();
    expect(out).toContain('DATABASE_URL=postgres://u:p@db/app?x=1');
    expect(out).toContain('OPENAI_KEY=sk-db');
    expect(out).toContain('# from the agent');
  });

  it('creates the file with a header when there is none', async () => {
    await fs.rm(envPath());
    await createEnvVar('p1', { key: 'A', value: '1' });
    expect(await readEnv()).toMatch(/^# Environment Variables[\s\S]*\nA=1\n$/);
  });
});
