import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const { rewriteHostDbUrl, HOST_DB_ALIAS } = await import('./host-db');

describe('rewriteHostDbUrl', () => {
  it('points the Coolify host URL at the in-network alias and internal port', () => {
    expect(rewriteHostDbUrl('postgresql://app:s3cr%40t@127.0.0.1:5564/kb?sslmode=disable', 'postgresql'))
      .toBe(`postgresql://app:s3cr%40t@${HOST_DB_ALIAS}:5432/kb?sslmode=disable`);
    expect(rewriteHostDbUrl('mysql://u:p@10.0.1.1:6001/shop', 'mysql')).toBe(`mysql://u:p@${HOST_DB_ALIAS}:3306/shop`);
  });
  it('refuses unknown engines, schemes and garbage', () => {
    expect(rewriteHostDbUrl('mongodb://u:p@h:1/db', 'mongodb')).toBeNull();
    expect(rewriteHostDbUrl('http://h:1/db', 'postgresql')).toBeNull();
    expect(rewriteHostDbUrl('not a url', 'postgresql')).toBeNull();
  });
});
