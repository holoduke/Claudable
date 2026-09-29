import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/claude-credentials', () => ({ credentialEnvName: () => 'CLAUDE_CODE_OAUTH_TOKEN' }));
vi.mock('@/lib/services/plugins', () => ({ CONTAINER_PLUGINS_MOUNT: '/plugins' }));

import { buildAgentContainerArgs } from './claude-container';
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
