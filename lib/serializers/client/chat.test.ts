import { describe, it, expect } from 'vitest';
import { normalizeChatContent, toChatMessage } from '@/lib/serializers/client/chat';

describe('normalizeChatContent', () => {
  it('returns "" for null/undefined', () => {
    expect(normalizeChatContent(null)).toBe('');
    expect(normalizeChatContent(undefined)).toBe('');
  });

  it('passes strings through', () => {
    expect(normalizeChatContent('hello')).toBe('hello');
  });

  it('joins arrays of strings', () => {
    expect(normalizeChatContent(['a', 'b', 'c'])).toBe('abc');
  });

  it('extracts text/content/value from array entries', () => {
    expect(
      normalizeChatContent([{ text: 'one' }, { content: 'two' }, { value: 'three' }]),
    ).toBe('onetwothree');
  });

  it('extracts the first matching key from an object', () => {
    expect(normalizeChatContent({ text: 'x' })).toBe('x');
    expect(normalizeChatContent({ content: 'y' })).toBe('y');
    expect(normalizeChatContent({ message: 'z' })).toBe('z');
  });

  it('recurses into object .parts', () => {
    expect(normalizeChatContent({ parts: [{ text: 'a' }, 'b'] })).toBe('ab');
  });

  it('falls back to JSON for unsupported shapes', () => {
    expect(normalizeChatContent(42)).toBe('42');
    expect(normalizeChatContent({ foo: 1 })).toBe('{"foo":1}');
  });
});

describe('toChatMessage', () => {
  it('maps snake_case fields to the camelCase ChatMessage shape', () => {
    const msg = toChatMessage({
      id: 'm1',
      project_id: 'p1',
      role: 'user',
      message_type: 'chat',
      content: 'hi',
      created_at: '2026-01-01T00:00:00.000Z',
      session_id: 's1',
      is_final: true,
    });
    expect(msg.id).toBe('m1');
    expect(msg.projectId).toBe('p1');
    expect(msg.role).toBe('user');
    expect(msg.messageType).toBe('chat');
    expect(msg.content).toBe('hi');
    expect(msg.sessionId).toBe('s1');
    expect(msg.isFinal).toBe(true);
    expect(msg.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('applies sensible defaults for missing fields', () => {
    const msg = toChatMessage({ content: 'x' });
    expect(msg.role).toBe('assistant');
    expect(msg.messageType).toBe('chat');
    expect(msg.isStreaming).toBe(false);
    expect(msg.isFinal).toBe(false);
    expect(msg.projectId).toBe('');
  });

  it('normalizes structured content into a string', () => {
    const msg = toChatMessage({ content: [{ text: 'a' }, { text: 'b' }] });
    expect(msg.content).toBe('ab');
  });

  it('carries commitSha (camel + snake) — the "Revert to here" checkpoint', () => {
    // Regression guard: dropping commitSha here made the revert button never render.
    expect(toChatMessage({ content: 'x', commitSha: 'abc123' }).commitSha).toBe('abc123');
    expect(toChatMessage({ content: 'x', commit_sha: 'def456' }).commitSha).toBe('def456');
    expect(toChatMessage({ content: 'x' }).commitSha).toBe(null);
  });
});
