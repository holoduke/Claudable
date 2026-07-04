import { describe, it, expect } from 'vitest';
import { orderServiceLevels } from './managed-containers';
import type { ManagedServiceSpec } from './managed-containers';

const svc = (id: string, kind: string, extra: Partial<ManagedServiceSpec> = {}): ManagedServiceSpec =>
  ({ id, name: id, image: `${id}:latest`, alias: id, kind, ...extra });

const ids = (levels: ManagedServiceSpec[][]) => levels.map((l) => l.map((s) => s.id).sort());

describe('orderServiceLevels (startup ordering)', () => {
  it('starts infra (db/cache) before app/worker services — the "app depends on db" default', () => {
    const levels = orderServiceLevels([
      svc('worker', 'service'),
      svc('db', 'database'),
      svc('cache', 'cache'),
    ]);
    expect(ids(levels)).toEqual([['cache', 'db'], ['worker']]);
  });

  it('honors an explicit dependsOn (by id or alias)', () => {
    const levels = orderServiceLevels([
      svc('api', 'service', { dependsOn: ['migrator'] }),
      svc('migrator', 'service'),
    ]);
    // migrator has no infra to wait for → level 0; api depends on it → level 1
    expect(ids(levels)).toEqual([['migrator'], ['api']]);
  });

  it('chains infra → migrator → api', () => {
    const levels = orderServiceLevels([
      svc('db', 'database'),
      svc('migrator', 'service'),                       // implicitly waits for db
      svc('api', 'service', { dependsOn: ['migrator'] }), // waits for db AND migrator
    ]);
    expect(ids(levels)).toEqual([['db'], ['migrator'], ['api']]);
  });

  it('a single service with no deps is one level', () => {
    expect(ids(orderServiceLevels([svc('db', 'database')]))).toEqual([['db']]);
  });

  it('breaks a dependency cycle instead of hanging', () => {
    const levels = orderServiceLevels([
      svc('a', 'service', { dependsOn: ['b'] }),
      svc('b', 'service', { dependsOn: ['a'] }),
    ]);
    // no ready node → both emitted together in a final level (no infinite loop)
    expect(levels.length).toBe(1);
    expect(ids(levels)).toEqual([['a', 'b']]);
  });

  it('resolves dependsOn given by alias, not id', () => {
    const levels = orderServiceLevels([
      svc('app', 'service', { dependsOn: ['redis'] }),
      svc('cache-1', 'cache', { alias: 'redis' }),
    ]);
    // app depends on the service whose ALIAS is redis (id cache-1), which is infra anyway
    expect(ids(levels)).toEqual([['cache-1'], ['app']]);
  });
});
