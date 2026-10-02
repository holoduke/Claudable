import { describe, it, expect } from 'vitest';
import {
  parseEnvFile,
  parseEnvLines,
  patchEnvContents,
  serializeEnvValue,
  mergeEnvView,
  isValidEnvKey,
} from './env-file';

const AGENT_FILE = [
  '# written by the agent',
  'DATABASE_URL=postgres://u:p@db:5432/app?sslmode=disable',
  '',
  'export STRIPE_KEY="sk_test_123"',
  "GREETING='hello world' # trailing comment",
  'MULTI="line1',
  'line2"',
  'URL_WITH_HASH=https://x.test/#anchor',
  'not a valid line',
  '',
].join('\n');

describe('parseEnvFile', () => {
  it('parses quotes, export, inline comments, multiline and `=` in values', () => {
    expect(parseEnvFile(AGENT_FILE)).toEqual({
      DATABASE_URL: 'postgres://u:p@db:5432/app?sslmode=disable',
      STRIPE_KEY: 'sk_test_123',
      GREETING: 'hello world',
      MULTI: 'line1\nline2',
      URL_WITH_HASH: 'https://x.test/#anchor',
    });
  });

  it('tolerates CRLF, blank lines and comments; last duplicate wins', () => {
    expect(parseEnvFile('# c\r\n\r\nA=1\r\nA=2\r\n')).toEqual({ A: '2' });
  });

  it('expands \\n in double quotes', () => {
    expect(parseEnvFile('K="a\\nb"')).toEqual({ K: 'a\nb' });
  });
});

describe('serializeEnvValue round-trip', () => {
  const cases = [
    'plain',
    'a=b=c',
    'has space',
    'has #hash',
    'dollar $HOME',
    'double "quote"',
    "single 'quote'",
    "both ' and \"",
    'multi\nline',
    'back\\slash',
    '',
  ];
  for (const value of cases) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      expect(parseEnvFile(`K=${serializeEnvValue(value)}\n`).K).toBe(value);
    });
  }
});

describe('patchEnvContents', () => {
  it('preserves file-only keys, comments and blank lines when setting a key', () => {
    const out = patchEnvContents(AGENT_FILE, { set: { NEW_KEY: 'v' } });
    expect(out.startsWith(AGENT_FILE)).toBe(true);
    expect(out.endsWith('NEW_KEY=v\n')).toBe(true);
    expect(parseEnvFile(out)).toMatchObject({
      DATABASE_URL: 'postgres://u:p@db:5432/app?sslmode=disable',
      STRIPE_KEY: 'sk_test_123',
      MULTI: 'line1\nline2',
      NEW_KEY: 'v',
    });
  });

  it('edited keys win and are replaced in place (export kept)', () => {
    const out = patchEnvContents(AGENT_FILE, { set: { STRIPE_KEY: 'sk_live_9', MULTI: 'one' } });
    const lines = out.split('\n');
    expect(lines[3]).toBe('export STRIPE_KEY=sk_live_9');
    expect(lines).toContain('MULTI=one');
    expect(lines).not.toContain('line2"');
    expect(lines).toContain('# written by the agent');
    expect(lines).toContain('not a valid line');
    expect(parseEnvFile(out).STRIPE_KEY).toBe('sk_live_9');
  });

  it('collapses duplicate keys to the edited value', () => {
    const out = patchEnvContents('A=1\nB=2\nA=3\n', { set: { A: 'x' } });
    expect(out).toBe('A=x\nB=2\n');
  });

  it('removes only the requested key', () => {
    const out = patchEnvContents(AGENT_FILE, { remove: ['GREETING', 'MULTI'] });
    const parsed = parseEnvFile(out);
    expect(parsed.GREETING).toBeUndefined();
    expect(parsed.MULTI).toBeUndefined();
    expect(parsed.DATABASE_URL).toBeDefined();
    expect(out).toContain('# written by the agent');
  });

  it('writes a header for a new file and leaves an empty file alone on no-op', () => {
    expect(patchEnvContents('', { set: { A: '1' } })).toMatch(/^# Environment Variables[\s\S]*\nA=1\n$/);
    expect(patchEnvContents('', { remove: ['A'] })).toBe('');
  });

  it('keeps comment lines that look like assignments', () => {
    const out = patchEnvContents('# A=old\nA=1\n', { set: { A: '2' } });
    expect(out).toBe('# A=old\nA=2\n');
  });

  it('parseEnvLines keeps unparseable lines as raw', () => {
    expect(parseEnvLines('nope\nA=1').map((l) => l.kind)).toEqual(['raw', 'var']);
  });
});

describe('mergeEnvView', () => {
  it('adds file-only keys as masked file rows, DB rows untouched', () => {
    const db = [{ id: '1', key: 'A', value: 'db', scope: 'runtime', var_type: 'string', is_secret: false }];
    const merged = mergeEnvView(db, { A: 'file', B: 'fileonly' });
    expect(merged).toEqual([
      { ...db[0], source: 'db' },
      { id: 'file:B', key: 'B', value: 'fileonly', scope: 'runtime', var_type: 'string', is_secret: true, description: null, source: 'file' },
    ]);
  });
});

describe('isValidEnvKey', () => {
  it('accepts normal keys and rejects injection', () => {
    expect(isValidEnvKey('DATABASE_URL')).toBe(true);
    expect(isValidEnvKey('next.public-x')).toBe(true);
    expect(isValidEnvKey('A\nB=evil')).toBe(false);
    expect(isValidEnvKey('A=B')).toBe(false);
    expect(isValidEnvKey('1A')).toBe(false);
    expect(isValidEnvKey('')).toBe(false);
  });
});
