import { describe, expect, it, vi } from 'vitest';

// claude.ts pulls in the whole agent runtime (DB, docker, MCP brokers); the
// functions under test are pure, so stub the heavy collaborators.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { AgentResumeRetryableError } from './agent-error';
import { buildInitialBuildPrompt, shouldRetryInFreshSession } from './claude';

describe('buildInitialBuildPrompt', () => {
  it('passes a slash command through unwrapped', () => {
    const prompt = '/filament:new-project Build a CRM with contacts';
    expect(buildInitialBuildPrompt('filament', prompt)).toBe(prompt);
    expect(buildInitialBuildPrompt('nuxt', `  ${prompt}\n`)).toBe(prompt);
    expect(buildInitialBuildPrompt(null, '/init')).toBe('/init');
  });

  it('wraps an ordinary prompt in the Nuxt template by default', () => {
    const out = buildInitialBuildPrompt('nuxt', 'A todo app');
    expect(out.startsWith('Build a Nuxt 4 application')).toBe(true);
    expect(out).toContain('A todo app');
  });

  it('gives document projects an HTML-document instruction, not Nuxt', () => {
    const out = buildInitialBuildPrompt('document', 'A quote for ACME');
    expect(out).toContain('A quote for ACME');
    expect(out).toContain('index.html');
    expect(out).toContain('@page');
    expect(out).not.toMatch(/Nuxt|npm install/);
  });

  it('gives imported static projects an in-place instruction, not Nuxt', () => {
    const out = buildInitialBuildPrompt('static', 'Change the header');
    expect(out).toContain('Change the header');
    expect(out).not.toContain('Nuxt');
  });

  it('keeps the other stacks unchanged', () => {
    expect(buildInitialBuildPrompt('next', 'x')).toMatch(/^Build a Next\.js/);
    expect(buildInitialBuildPrompt('angular', 'x')).toMatch(/^Build an Angular/);
    expect(buildInitialBuildPrompt('filament', 'x')).toMatch(/^Extend the NewStory Filament/);
  });
});

describe('shouldRetryInFreshSession', () => {
  it('retries a resumed turn that failed before any output', () => {
    expect(shouldRetryInFreshSession('sess', new AgentResumeRetryableError('No conversation found'))).toBe(true);
  });

  it('does not retry a failure after output, or a fresh-session failure', () => {
    expect(shouldRetryInFreshSession('sess', new Error('The agent run failed while it was working.'))).toBe(false);
    expect(shouldRetryInFreshSession(undefined, new AgentResumeRetryableError('x'))).toBe(false);
  });
});
