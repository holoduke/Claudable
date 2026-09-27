import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let settings: string | null = null;
let coolify: unknown = null;
vi.mock('@/lib/services/project', () => ({ getProjectById: async () => ({ id: 'p', settings }) }));
vi.mock('@/lib/services/project-services', () => ({ getProjectService: async () => coolify }));
const db = await import('./sqlite-db');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlitedb-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => { settings = null; coolify = null; });

describe('sqlite-db', () => {
  it('gives every consumer an absolute file URL plus the plain path', () => {
    expect(db.sqliteEnv('/app/.data/app.db')).toEqual({
      DATABASE_URL: 'file:/app/.data/app.db', DATABASE_PATH: '/app/.data/app.db', SQLITE_PATH: '/app/.data/app.db',
    });
  });

  it('only counts as SQLite when chosen and no server database is attached', async () => {
    expect(await db.projectUsesSqlite('p')).toBe(false);
    settings = JSON.stringify({ databaseType: 'postgres' });
    expect(await db.projectUsesSqlite('p')).toBe(false);
    settings = JSON.stringify({ databaseType: 'sqlite' });
    expect(await db.projectUsesSqlite('p')).toBe(true);
    coolify = { serviceData: { engine: 'postgresql' } };
    expect(await db.projectUsesSqlite('p')).toBe(false);
    coolify = null; settings = '{broken';
    expect(await db.projectUsesSqlite('p')).toBe(false);
  });

  it('creates .data/ and git-ignores it exactly once, keeping existing rules', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'p-'));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/');
    await db.ensureSqliteDir(dir);
    await db.ensureSqliteDir(dir);
    expect(fs.statSync(path.join(dir, '.data')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.data/\n');
  });

  it('refuses a .data symlink that points outside the project', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'q-'));
    const outside = fs.mkdtempSync(path.join(ROOT, 'out-'));
    fs.symlinkSync(outside, path.join(dir, '.data'));
    await expect(db.ensureSqliteDir(dir)).rejects.toThrow();
  });

  it('tells the agent which database it has', () => {
    expect(db.databasePromptNote(null)).toBe('');
    expect(db.databasePromptNote('postgres')).toContain('PostgreSQL');
    expect(db.databasePromptNote('sqlite')).toContain('DATABASE_PATH');
  });
});
