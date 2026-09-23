import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MODEL_DEFINITIONS,
  CLAUDE_DEFAULT_MODEL,
  normalizeClaudeModelId,
  getClaudeModelDisplayName,
} from './claudeModels';

describe('model alias map', () => {
  it('has no alias claimed by two models', () => {
    // The map is built by reducing over the definitions, so a repeated alias is
    // silently won by whichever model is listed LAST — a generation bump would
    // then quietly route "opus" back to the older model. Fail loudly instead.
    const owners = new Map<string, string[]>();
    for (const def of CLAUDE_MODEL_DEFINITIONS) {
      for (const alias of [...def.aliases, def.id]) {
        const key = alias.trim().toLowerCase().replace(/[\s_]+/g, '-');
        owners.set(key, [...(owners.get(key) ?? []), def.id]);
      }
    }
    const duplicates = [...owners.entries()].filter(([, ids]) => new Set(ids).size > 1);
    expect(duplicates).toEqual([]);
  });

  it('routes the generic opus aliases to the newest Opus', () => {
    expect(normalizeClaudeModelId('opus')).toBe('claude-opus-5-5');
    expect(normalizeClaudeModelId('claude-opus')).toBe('claude-opus-5-5');
  });

  it('keeps explicit versions pinned to their own model', () => {
    expect(normalizeClaudeModelId('claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeClaudeModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(normalizeClaudeModelId('opus-5.5')).toBe('claude-opus-5-5');
  });

  it('normalizes spacing and casing', () => {
    expect(normalizeClaudeModelId('  Claude Opus 5.5 ')).toBe('claude-opus-5-5');
    expect(normalizeClaudeModelId('CLAUDE_OPUS_5_5')).toBe('claude-opus-5-5');
  });

  it('falls back to the default for an unknown id', () => {
    expect(normalizeClaudeModelId('gpt-9')).toBe(CLAUDE_DEFAULT_MODEL);
    expect(normalizeClaudeModelId('')).toBe(CLAUDE_DEFAULT_MODEL);
    expect(normalizeClaudeModelId(null)).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('resolves the configured default to a real definition', () => {
    expect(CLAUDE_MODEL_DEFINITIONS.map((d) => d.id)).toContain(CLAUDE_DEFAULT_MODEL);
  });

  it('gives every model a display name', () => {
    expect(getClaudeModelDisplayName('claude-opus-5-5')).toBe('Claude Opus 5.5');
    for (const def of CLAUDE_MODEL_DEFINITIONS) {
      expect(getClaudeModelDisplayName(def.id)).toBe(def.name);
    }
  });
});
