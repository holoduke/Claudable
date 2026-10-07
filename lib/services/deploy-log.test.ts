import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('./project-services', () => ({ getProjectService: vi.fn() }));

const { cleanLog, redact, summarize } = await import('./deploy-log');

describe('redact', () => {
  it('masks credentials in URLs, auth headers, known token prefixes and KEY=value secrets', () => {
    expect(redact('git clone https://oauth2:abcdef123456@git.newstory.tf/x.git')).toBe('git clone https://***:***@git.newstory.tf/x.git');
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuv')).toBe('Authorization: Bearer ***');
    expect(redact('token ghp_abcdefghijklmnopqrstuvwxyz123456')).toBe('token ***');
    expect(redact('use aih_abcdefghijklmnopqrstuvwxyz0123')).toBe('use ***');
    expect(redact('NUXT_SESSION_PASSWORD=supersecretvalue other=1')).toBe('NUXT_SESSION_PASSWORD=*** other=1');
    expect(redact('DB_API_KEY: "x y z"')).toBe('DB_API_KEY=***');
    expect(redact('AKIAABCDEFGHIJKLMNOP')).toBe('***');
  });
  it('leaves normal log lines alone', () => {
    expect(redact('npm run build')).toBe('npm run build');
    expect(redact('see https://example.com/docs')).toBe('see https://example.com/docs');
  });
});

describe('cleanLog + summarize', () => {
  const raw = [
    '2026-10-07T07:11:16.5759658Z host-runner received task 3211',
    "2026-10-07T07:11:16.5768216Z evaluating expression 'success()'",
    '2026-10-07T07:11:16.5778558Z Wrote command \\n\\nset -euo pipefail\\nREPO="https://oauth2:${DEPLOY_TOKEN}@git"',
    '2026-10-07T07:11:41.0828743Z \u001b[31m => ERROR [build 6/6] RUN npm test && npm run build\u001b[0m',
    '2026-10-07T07:11:41.1566957Z 22.14 Error: Hook timed out in 10000ms.',
    '2026-10-07T07:11:41.1610472Z   ❌  Failure - Main Build, deploy en route aihub',
    '2026-10-07T07:11:41.1632813Z Job \'deploy\' failed',
  ].join('\n');

  it('strips timestamps, ANSI, expression noise and the workflow script', () => {
    const lines = cleanLog(raw);
    expect(lines[0]).toBe('host-runner received task 3211');
    expect(lines).toContain('[workflow-script weggelaten]');
    expect(lines.join('\n')).not.toMatch(/\u001b|DEPLOY_TOKEN|evaluating expression|2026-10-07T/);
  });
  it('extracts the error lines and keeps a tail', () => {
    const s = summarize(cleanLog(raw));
    expect(s.errors).toEqual([
    ' => ERROR [build 6/6] RUN npm test && npm run build',
      '22.14 Error: Hook timed out in 10000ms.',
      '  ❌  Failure - Main Build, deploy en route aihub',
      "Job 'deploy' failed",
    ]);
    expect(s.tail.split('\n').at(-1)).toBe("Job 'deploy' failed");
    expect(s.truncated).toBe(false);
  });
  it('caps the tail on long logs', () => {
    const s = summarize(Array.from({ length: 1000 }, (_, i) => `line ${i}`));
    expect(s.tail.split('\n')).toHaveLength(250);
    expect(s.truncated).toBe(true);
  });
});
