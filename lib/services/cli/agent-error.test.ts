import { describe, expect, it } from 'vitest';
import { isTechnicalNoise, toUserFacingAgentError } from './agent-error';

// The exact (truncated) stderr tail that reached production chat on
// 2026-07-08 when the agent container's CLI entrypoint went missing.
const TRUNCATED_STACK_TAIL = `s/cjs/loader:1430:15)
    at defaultResolveImpl (node:internal/modules/cjs/loader:1040:19)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1045:22)
    at Function._load (node:internal/modules/cjs/loader:1216:25)
    at wrapModuleLoad (node:internal/modules/cjs/loader:254:19)
    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)
    at node:internal/main/run_main_module:36:49 {
  code: 'MODULE_NOT_FOUND',
  requireStack: []
}

Node.js v22.23.1`;

describe('isTechnicalNoise', () => {
  it('detects a truncated Node stack-trace tail', () => {
    expect(isTechnicalNoise(TRUNCATED_STACK_TAIL)).toBe(true);
  });

  it('detects missing-module errors', () => {
    expect(isTechnicalNoise("Error: Cannot find module '/app/node_modules/x/cli.js'")).toBe(true);
  });

  it('detects spawn failures', () => {
    expect(isTechnicalNoise('Error: spawn docker ENOENT')).toBe(true);
  });

  it('leaves human-readable messages alone', () => {
    expect(isTechnicalNoise('Agent turn failed (error_during_execution).')).toBe(false);
    expect(isTechnicalNoise('Claude Code CLI authentication required.\n\nAuthentication method:\nclaude auth login')).toBe(false);
    expect(isTechnicalNoise('Agent container exited with code 137.')).toBe(false);
  });
});

describe('toUserFacingAgentError', () => {
  it('replaces the production stack-trace tail with a friendly message', () => {
    const result = toUserFacingAgentError(TRUNCATED_STACK_TAIL);
    expect(result).not.toContain('node:internal');
    expect(result).not.toContain('MODULE_NOT_FOUND');
    expect(result).toContain('try sending your message again');
    expect(result).toContain('(ref: agent-component-missing)');
  });

  it('classifies spawn failures with their own reference code', () => {
    expect(toUserFacingAgentError('Error: spawn docker ENOENT')).toContain('(ref: agent-start-failed)');
  });

  it('passes curated human-readable messages through unchanged', () => {
    const curated = 'Agent turn failed (error_during_execution).';
    expect(toUserFacingAgentError(curated)).toBe(curated);
  });

  it('falls back to a generic message for empty input', () => {
    expect(toUserFacingAgentError('')).toContain('(ref: agent-internal-error)');
    expect(toUserFacingAgentError(undefined)).toContain('(ref: agent-internal-error)');
  });
});
