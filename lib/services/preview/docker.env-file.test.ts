import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, existsSync } from 'fs';
import { writeContainerEnvFile } from './docker';

describe('writeContainerEnvFile', () => {
  it('emits no --env-file args and a no-op cleanup for empty env', () => {
    const r = writeContainerEnvFile({});
    expect(r.args).toEqual([]);
    expect(() => r.cleanup()).not.toThrow();
  });

  it('writes a 0600 file passed only via --env-file (never inline on the argv)', () => {
    const r = writeContainerEnvFile({ DATABASE_URL: 'postgres://u:p@db:5432/app' });
    try {
      expect(r.args[0]).toBe('--env-file');
      const filePath = r.args[1];
      // The secret VALUE must never appear in the argv — only the file path.
      expect(r.args.join(' ')).not.toContain('postgres://');
      const mode = statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(readFileSync(filePath, 'utf8')).toContain('DATABASE_URL=postgres://u:p@db:5432/app');
    } finally {
      r.cleanup();
    }
  });

  it('keeps the last value for a duplicate key so callers can encode precedence', () => {
    // Object insertion collapses duplicates to the latest value — the ordered
    // record the frontend builds relies on this (project vars override base vars).
    const r = writeContainerEnvFile({ PORT: '3710', HOST: '0.0.0.0' });
    try {
      const body = readFileSync(r.args[1], 'utf8');
      expect(body).toContain('PORT=3710');
      expect(body).toContain('HOST=0.0.0.0');
    } finally {
      r.cleanup();
    }
  });

  it('strips newlines from values so a multi-line value cannot inject extra vars', () => {
    const r = writeContainerEnvFile({ TOKEN: 'abc\nINJECTED=evil' });
    try {
      const line = readFileSync(r.args[1], 'utf8').split('\n').find((l) => l.startsWith('TOKEN='));
      expect(line).toBe('TOKEN=abc INJECTED=evil'); // one line, no real second var
    } finally {
      r.cleanup();
    }
  });

  it('cleanup removes the file and is safe to call twice', () => {
    const r = writeContainerEnvFile({ A: '1' });
    const filePath = r.args[1];
    expect(existsSync(filePath)).toBe(true);
    r.cleanup();
    expect(existsSync(filePath)).toBe(false);
    expect(() => r.cleanup()).not.toThrow();
  });
});
