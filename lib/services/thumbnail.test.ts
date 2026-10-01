import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/services/tenant-policy', () => ({ isCustomerProject: async () => false }));

import { chromeFailure } from './thumbnail';

describe('chromeFailure', () => {
  it('reports a timeout kill in one line', () => {
    expect(chromeFailure({ killed: true, signal: 'SIGTERM', code: 143, message: 'Command failed: /opt/chrome --headless http://10.0.1.1:3710/\n[dbus] noise\n[gpu] noise' })).toBe('timed out (SIGTERM)');
  });
  it('drops the command line (internal address) and the stderr dump', () => {
    const msg = chromeFailure({ code: 1, message: 'Command failed: /opt/chrome --headless http://10.0.1.1:3710/\nERROR:dbus noise' });
    expect(msg).toBe('chrome exited (exit 1)');
    expect(msg).not.toMatch(/10\.0\.1\.1|dbus/);
  });
  it('keeps a plain error message', () => {
    expect(chromeFailure(new Error('empty screenshot'))).toBe('empty screenshot');
  });
});
