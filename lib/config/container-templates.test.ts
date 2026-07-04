import { describe, it, expect } from 'vitest';
import { CONTAINER_TEMPLATES, getContainerTemplate } from './container-templates';

// The only placeholders the runtime (managed-containers.ts) resolves.
const KNOWN = new Set(['alias', 'port', 'user', 'pass', 'db']);
const placeholders = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

describe('container templates', () => {
  it('have unique ids and required fields', () => {
    const ids = CONTAINER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of CONTAINER_TEMPLATES) {
      expect(t.image, `${t.id} image`).toBeTruthy();
      expect(t.alias, `${t.id} alias`).toMatch(/^[a-z0-9-]+$/);
      expect(t.kind, `${t.id} kind`).toBeTruthy();
    }
  });

  it('only use placeholders the runtime can resolve', () => {
    for (const t of CONTAINER_TEMPLATES) {
      for (const map of [t.containerEnv, t.injectEnv]) {
        for (const v of Object.values(map ?? {})) {
          for (const p of placeholders(v)) {
            expect(KNOWN.has(p), `${t.id} uses unknown placeholder {${p}} in "${v}"`).toBe(true);
          }
        }
      }
    }
  });

  it('credential placeholders {user}{pass}{db} appear only when secrets are generated', () => {
    for (const t of CONTAINER_TEMPLATES) {
      const usesCreds = [t.containerEnv, t.injectEnv].some((m) =>
        Object.values(m ?? {}).some((v) => placeholders(v).some((p) => p === 'user' || p === 'pass' || p === 'db')));
      if (usesCreds) {
        expect(t.secrets === 'postgres' || t.secrets === 'mysql', `${t.id} uses creds but generates none`).toBe(true);
      }
    }
  });

  it('exposes a lookup by id', () => {
    expect(getContainerTemplate('postgres')?.image).toContain('pgvector');
    expect(getContainerTemplate('redis')?.kind).toBe('cache');
    expect(getContainerTemplate('nope')).toBeUndefined();
  });
});
