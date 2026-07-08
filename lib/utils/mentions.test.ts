import { describe, expect, it } from 'vitest';
import {
  activeMentionQuery,
  parseMentionsJson,
  sanitizeMentions,
  splitBodyByMentions,
} from './mentions';

describe('sanitizeMentions', () => {
  it('accepts well-formed entries and trims them', () => {
    expect(sanitizeMentions([{ id: ' u1 ', name: ' Anna ' }])).toEqual([{ id: 'u1', name: 'Anna' }]);
  });

  it('drops malformed entries, dedupes ids, and caps the list', () => {
    const raw = [
      { id: 'u1', name: 'Anna' },
      { id: 'u1', name: 'Anna dup' },
      { id: 'u2' },
      { name: 'no id' },
      'garbage',
      null,
      ...Array.from({ length: 30 }, (_, i) => ({ id: `bulk${i}`, name: `Bulk ${i}` })),
    ];
    const result = sanitizeMentions(raw);
    expect(result[0]).toEqual({ id: 'u1', name: 'Anna' });
    expect(result.filter((m) => m.id === 'u1')).toHaveLength(1);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('returns [] for non-arrays', () => {
    expect(sanitizeMentions('nope')).toEqual([]);
    expect(sanitizeMentions(undefined)).toEqual([]);
  });
});

describe('parseMentionsJson', () => {
  it('round-trips a stored column value', () => {
    expect(parseMentionsJson(JSON.stringify([{ id: 'u1', name: 'Anna' }]))).toEqual([{ id: 'u1', name: 'Anna' }]);
  });

  it('tolerates null and invalid JSON', () => {
    expect(parseMentionsJson(null)).toEqual([]);
    expect(parseMentionsJson('{oops')).toEqual([]);
  });
});

describe('splitBodyByMentions', () => {
  const anna = { id: 'u1', name: 'Anna' };
  const annaMaria = { id: 'u2', name: 'Anna Maria' };

  it('splits text around a mention', () => {
    expect(splitBodyByMentions('Hey @Anna, look at this', [anna])).toEqual([
      { type: 'text', text: 'Hey ' },
      { type: 'mention', text: '@Anna', mention: anna },
      { type: 'text', text: ', look at this' },
    ]);
  });

  it('prefers the longer name when one prefixes another', () => {
    const segments = splitBodyByMentions('cc @Anna Maria please', [anna, annaMaria]);
    expect(segments).toContainEqual({ type: 'mention', text: '@Anna Maria', mention: annaMaria });
    expect(segments.filter((s) => s.type === 'mention')).toHaveLength(1);
  });

  it('highlights repeated mentions and leaves unmatched ones plain', () => {
    const segments = splitBodyByMentions('@Anna and @Anna again, @Ghost', [anna, { id: 'u9', name: 'Nobody' }]);
    expect(segments.filter((s) => s.type === 'mention')).toHaveLength(2);
    expect(segments.map((s) => s.text).join('')).toBe('@Anna and @Anna again, @Ghost');
  });

  it('passes through bodies without mentions', () => {
    expect(splitBodyByMentions('plain text', [])).toEqual([{ type: 'text', text: 'plain text' }]);
  });
});

describe('activeMentionQuery', () => {
  it('finds the token from @ to the caret', () => {
    expect(activeMentionQuery('hey @An', 7)).toEqual({ start: 4, query: 'An' });
  });

  it('allows spaces so multi-word names keep matching', () => {
    expect(activeMentionQuery('cc @Anna Ma', 11)).toEqual({ start: 3, query: 'Anna Ma' });
  });

  it('matches at the very start of the text', () => {
    expect(activeMentionQuery('@a', 2)).toEqual({ start: 0, query: 'a' });
  });

  it('ignores mid-word @ (email addresses)', () => {
    expect(activeMentionQuery('mail gillis@new', 15)).toBeNull();
  });

  it('returns null without an @ before the caret or across newlines', () => {
    expect(activeMentionQuery('no tag here', 5)).toBeNull();
    expect(activeMentionQuery('@anna\nnext line', 12)).toBeNull();
  });
});
