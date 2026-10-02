import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/claude-credentials', () => ({ credentialEnvName: () => 'CLAUDE_CODE_OAUTH_TOKEN' }));
vi.mock('@/lib/services/plugins', () => ({ CONTAINER_PLUGINS_MOUNT: '/plugins' }));

import { buildAgentContainerArgs, thinkingCliArgs } from './claude-container';
import { guardHookSettings, RESTRICTED_TOOLS } from '@/lib/services/edit-profiles';

const base = { projectHostPath: '/p', prompt: 'x', oauthToken: 't', envFilePath: '/tmp/env' };

describe('buildAgentContainerArgs — edit profile flags', () => {
  it('adds --tools, --disallowedTools and --settings for a restricted profile', () => {
    const args = buildAgentContainerArgs({ ...base, tools: RESTRICTED_TOOLS.join(' '), disallowedTools: 'Bash Task', settingsJson: guardHookSettings() });
    expect(args[args.indexOf('--tools') + 1]).toBe(RESTRICTED_TOOLS.join(' '));
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash Task');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]).hooks.PreToolUse[0].hooks[0].command).toBe('node /app/lib/edit-guard/guard.cjs');
    expect(RESTRICTED_TOOLS).not.toContain('Bash');
    expect(RESTRICTED_TOOLS).not.toContain('Task');
  });
  it('adds none of them for a full profile, and --pids-limit only once', () => {
    const args = buildAgentContainerArgs(base);
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--settings');
    expect(args.filter((a) => a === '--pids-limit')).toHaveLength(1);
  });
});

describe('buildAgentContainerArgs — thinking mode', () => {
  const imageIndex = (args: string[]) => args.indexOf('/usr/local/bin/claude');

  it('auto / unset adds no thinking env or flags (unchanged default)', () => {
    for (const thinkingMode of [undefined, 'auto'] as const) {
      const args = buildAgentContainerArgs({ ...base, thinkingMode });
      expect(args.join(' ')).not.toContain('MAX_THINKING_TOKENS');
      expect(args).not.toContain('--effort');
    }
    expect(buildAgentContainerArgs({ ...base, thinkingMode: 'auto' })).toEqual(buildAgentContainerArgs(base));
  });

  it("'off' passes --effort low to the CLI (after the image) and sets no env", () => {
    const args = buildAgentContainerArgs({ ...base, thinkingMode: 'off' });
    const at = args.indexOf('--effort');
    expect(at).toBeGreaterThan(args.indexOf('claudable-claudable'));
    expect(args[at + 1]).toBe('low');
    expect(args.join(' ')).not.toContain('MAX_THINKING_TOKENS');
  });

  it("'forced' passes --effort high to the CLI (after the image)", () => {
    const args = buildAgentContainerArgs({ ...base, thinkingMode: 'forced', sessionId: 's1' });
    const at = args.indexOf('--effort');
    expect(args[at + 1]).toBe('high');
    expect(at).toBeGreaterThan(imageIndex(args));
    expect(args.join(' ')).not.toContain('MAX_THINKING_TOKENS');
  });
});

describe('thinkingCliArgs', () => {
  it('maps each mode', () => {
    expect(thinkingCliArgs('off')).toEqual({ dockerEnv: [], cliFlags: ['--effort', 'low'] });
    expect(thinkingCliArgs('forced')).toEqual({ dockerEnv: [], cliFlags: ['--effort', 'high'] });
    expect(thinkingCliArgs('auto')).toEqual({ dockerEnv: [], cliFlags: [] });
    expect(thinkingCliArgs(undefined)).toEqual({ dockerEnv: [], cliFlags: [] });
  });
});
