import { describe, expect, it } from 'vitest';
import { CHAT_MODE_TOOLS, chatModePromptNote, parseTurnMode, selectTurnTools } from './turn-tools';
import { RESTRICTED_TOOLS } from '@/lib/services/edit-profiles';

const WRITERS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task'];

describe('parseTurnMode', () => {
  it('only an explicit "chat" is chat mode', () => {
    expect(parseTurnMode('chat')).toBe('chat');
    expect(parseTurnMode('act')).toBe('act');
    expect(parseTurnMode(undefined)).toBe('act');
    expect(parseTurnMode('CHAT')).toBe('act');
    expect(parseTurnMode(1)).toBe('act');
  });
});

describe('selectTurnTools', () => {
  it('a full-profile act turn is unrestricted', () => {
    expect(selectTurnTools({ mode: 'act', restrictedProfile: false })).toBeNull();
  });

  it('a restricted-profile act turn gets the edit-profile allowlist', () => {
    const p = selectTurnTools({ mode: 'act', restrictedProfile: true })!;
    expect(p.tools).toEqual(RESTRICTED_TOOLS);
    expect(p.disallowedTools).toContain('Bash');
  });

  it('chat mode is read-only: no writers allowed, all writers denied', () => {
    const p = selectTurnTools({ mode: 'chat', restrictedProfile: false })!;
    expect(p.tools).toEqual([...CHAT_MODE_TOOLS]);
    for (const tool of WRITERS) {
      expect(p.tools).not.toContain(tool);
      expect(p.disallowedTools).toContain(tool);
    }
  });

  it('chat + restricted profile is the intersection and never widens either', () => {
    const p = selectTurnTools({ mode: 'chat', restrictedProfile: true })!;
    for (const tool of p.tools) {
      expect(RESTRICTED_TOOLS).toContain(tool);
      expect(CHAT_MODE_TOOLS).toContain(tool);
    }
    expect(p.tools).not.toContain('Write');
    expect(p.tools).not.toContain('Edit');
    expect(p.tools).toContain('Read');
    // Union of both denylists.
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'Task', 'Monitor']));
    // No tool is both allowed and denied.
    expect(p.tools.filter((t) => p.disallowedTools.includes(t))).toEqual([]);
  });

  it('the chat prompt note tells the agent it cannot edit', () => {
    expect(chatModePromptNote()).toMatch(/read-only/i);
  });
});
