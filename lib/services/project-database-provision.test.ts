import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ managed: true }));
const addServiceFromTemplate = vi.hoisted(() => vi.fn(async () => ({ id: 'x' })));
const provisionPostgres = vi.hoisted(() => vi.fn(async () => ({ provisioned: true })));

vi.mock('@/lib/services/managed-containers', () => ({
  managedContainersEnabled: () => state.managed,
  addServiceFromTemplate,
}));
vi.mock('@/lib/services/database', () => ({ provisionPostgres }));

import { databaseAvailable, provisionProjectDatabase } from './project-database-provision';
import { getContainerTemplate } from '@/lib/config/container-templates';

describe('provisionProjectDatabase', () => {
  beforeEach(() => {
    state.managed = true;
    addServiceFromTemplate.mockClear();
    provisionPostgres.mockClear();
  });

  it('creates a per-project MySQL container from the mysql template', async () => {
    expect(await provisionProjectDatabase('p1', 'mysql')).toBe('container');
    expect(addServiceFromTemplate).toHaveBeenCalledWith('p1', 'mysql');
  });

  it('creates a per-project Postgres container when managed containers are on', async () => {
    expect(await provisionProjectDatabase('p1', 'postgres')).toBe('container');
    expect(addServiceFromTemplate).toHaveBeenCalledWith('p1', 'postgres');
    expect(provisionPostgres).not.toHaveBeenCalled();
  });

  it('falls back to the Coolify host DB for Postgres without managed containers', async () => {
    state.managed = false;
    expect(await provisionProjectDatabase('p1', 'postgres')).toBe('coolify');
    expect(provisionPostgres).toHaveBeenCalledWith('p1');
  });

  it('refuses MySQL without managed containers (no host fallback exists)', async () => {
    state.managed = false;
    await expect(provisionProjectDatabase('p1', 'mysql')).rejects.toThrow(/managed containers/);
    expect(addServiceFromTemplate).not.toHaveBeenCalled();
  });

  it('provisions nothing for SQLite', async () => {
    expect(await provisionProjectDatabase('p1', 'sqlite')).toBe('none');
    expect(addServiceFromTemplate).not.toHaveBeenCalled();
  });
});

describe('databaseAvailable', () => {
  it('MySQL only with managed containers; others always', async () => {
    state.managed = false;
    expect(await databaseAvailable('mysql')).toBe(false);
    expect(await databaseAvailable('postgres')).toBe(true);
    expect(await databaseAvailable('sqlite')).toBe(true);
    state.managed = true;
    expect(await databaseAvailable('mysql')).toBe(true);
  });
});

describe('mysql container template', () => {
  it('uses the official image with a volume, healthcheck and injected DATABASE_URL', () => {
    const t = getContainerTemplate('mysql');
    expect(t?.image).toMatch(/^mysql:/);
    expect(t?.mountPath).toBe('/var/lib/mysql');
    expect(t?.healthCmd).toContain('mysqladmin ping');
    expect(t?.secrets).toBe('mysql');
    expect(t?.injectEnv?.DATABASE_URL).toMatch(/^mysql:\/\//);
  });
});
