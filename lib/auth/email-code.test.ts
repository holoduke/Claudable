import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { id: string; email: string; codeHash: string; expiresAt: Date; attempts: number; usedAt: Date | null; createdAt: Date };
const rows: Row[] = [];
const sent: { to: string; code: string }[] = [];
const allowed = new Set<string>();
let seq = 0;

const matches = (r: Row, where: any) =>
  (where.id === undefined || r.id === where.id) &&
  (where.email === undefined || r.email === where.email) &&
  (where.usedAt === undefined || (where.usedAt === null ? r.usedAt === null : true)) &&
  (!where.expiresAt || r.expiresAt > where.expiresAt.gt) &&
  (!where.createdAt || r.createdAt >= where.createdAt.gte);

vi.mock('@/lib/db/client', () => {
  const loginCode = {
    count: vi.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
    create: vi.fn(async ({ data }: any) => { const r = { id: `c${++seq}`, attempts: 0, usedAt: null, createdAt: new Date(), ...data }; rows.push(r); return r; }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const r = rows.find((x) => x.id === where.id)!;
      if (data.attempts?.increment) r.attempts += data.attempts.increment;
      return r;
    }),
    findFirst: vi.fn(async ({ where }: any) =>
      rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null),
  };
  return { prisma: { loginCode, $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops) } };
});
vi.mock('@/lib/auth/provision', () => ({ isSignInAllowed: vi.fn(async (email: string) => allowed.has(email)) }));
vi.mock('@/lib/services/mail', () => ({
  loginCodeEmail: (i: { to: string; code: string }) => i,
  sendMail: vi.fn(async (m: { to: string; code: string }) => { sent.push(m); return { sent: true }; }),
}));

import { requestLoginCode, verifyLoginCode } from './email-code';

beforeEach(() => {
  rows.length = 0;
  sent.length = 0;
  allowed.clear();
  allowed.add('client@acme.example');
  process.env.AUTH_SECRET = 'test-secret';
});

const lastCode = () => sent[sent.length - 1].code;

describe('e-mail sign-in codes', () => {
  it('sends a code only to an address that may sign in', async () => {
    expect(await requestLoginCode('stranger@example.com', '1.1.1.1')).toBe(false);
    expect(sent).toHaveLength(0);
    expect(await requestLoginCode('Client@Acme.example', '1.1.1.2')).toBe(true);
    expect(sent[0].to).toBe('client@acme.example');
    expect(rows[0].codeHash).not.toContain(lastCode()); // only a hash is stored
  });

  it('signs in with the right code exactly once', async () => {
    await requestLoginCode('client@acme.example', '1.1.1.3');
    const code = lastCode();
    expect(await verifyLoginCode('client@acme.example', code)).toBe('client@acme.example');
    expect(await verifyLoginCode('client@acme.example', code)).toBeNull();
  });

  it('rejects a wrong code and locks after five attempts', async () => {
    await requestLoginCode('client@acme.example', '1.1.1.4');
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(await verifyLoginCode('client@acme.example', wrong)).toBeNull();
    expect(await verifyLoginCode('client@acme.example', code)).toBeNull();
  });

  it('rejects an expired code and a code for another address', async () => {
    await requestLoginCode('client@acme.example', '1.1.1.5');
    const code = lastCode();
    expect(await verifyLoginCode('someone@acme.example', code)).toBeNull();
    rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await verifyLoginCode('client@acme.example', code)).toBeNull();
  });

  it('a new code replaces the previous one', async () => {
    await requestLoginCode('client@acme.example', '1.1.1.6');
    const first = lastCode();
    await requestLoginCode('client@acme.example', '1.1.1.6');
    const second = lastCode();
    if (first !== second) expect(await verifyLoginCode('client@acme.example', first)).toBeNull();
    expect(await verifyLoginCode('client@acme.example', second)).toBe('client@acme.example');
  });
});
