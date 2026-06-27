import { describe, it, expect } from 'vitest';
import {
  normalizeAction,
  inferActionFromToolName,
  pickFirstString,
  extractPathFromInput,
  buildToolMetadata,
} from '@/lib/services/cli/tool-metadata';

describe('normalizeAction', () => {
  it('maps verbs to canonical actions', () => {
    expect(normalizeAction('modify')).toBe('Edited');
    expect(normalizeAction('create')).toBe('Created');
    expect(normalizeAction('view')).toBe('Read');
    expect(normalizeAction('remove')).toBe('Deleted');
    expect(normalizeAction('grep')).toBe('Searched');
    expect(normalizeAction('todo')).toBe('Generated');
    expect(normalizeAction('run bash')).toBe('Executed');
  });
  it('returns undefined for non-strings / unknowns', () => {
    expect(normalizeAction(undefined)).toBeUndefined();
    expect(normalizeAction(42)).toBeUndefined();
    expect(normalizeAction('frobnicate')).toBeUndefined();
  });
});

describe('inferActionFromToolName', () => {
  it('uses the exact tool-name map', () => {
    expect(inferActionFromToolName('write_file')).toBe('Created');
    expect(inferActionFromToolName('edit')).toBe('Edited');
    expect(inferActionFromToolName('bash')).toBe('Executed');
  });
  it('handles namespaced tool names via the suffix', () => {
    expect(inferActionFromToolName('mcp:read_file')).toBe('Read');
  });
  it('falls back to verb inference', () => {
    expect(inferActionFromToolName('searchProject')).toBe('Searched');
  });
});

describe('pickFirstString', () => {
  it('returns trimmed non-empty strings', () => {
    expect(pickFirstString('  hi ')).toBe('hi');
    expect(pickFirstString('   ')).toBeUndefined();
  });
  it('stringifies numbers and booleans', () => {
    expect(pickFirstString(7)).toBe('7');
    expect(pickFirstString(false)).toBe('false');
  });
  it('digs into arrays and known nested keys', () => {
    expect(pickFirstString(['', 'x'])).toBe('x');
    expect(pickFirstString({ path: 'a/b.ts' })).toBe('a/b.ts');
    expect(pickFirstString({ file_path: 'c.ts' })).toBe('c.ts');
  });
});

describe('extractPathFromInput', () => {
  it('pulls the path from common key shapes', () => {
    expect(extractPathFromInput({ file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(extractPathFromInput({ filePath: 'src/b.ts' })).toBe('src/b.ts');
    expect(extractPathFromInput({ pattern: '**/*.vue' })).toBe('**/*.vue');
  });
  it('returns the command for executed actions when no path key exists', () => {
    expect(extractPathFromInput({ command: 'npm run build' }, 'Executed')).toBe('npm run build');
  });
  it('returns undefined for non-objects', () => {
    expect(extractPathFromInput(null)).toBeUndefined();
    expect(extractPathFromInput('x')).toBeUndefined();
  });
});

describe('buildToolMetadata', () => {
  it('derives action + filePath for an edit', () => {
    const m = buildToolMetadata({ name: 'edit_file', input: { file_path: 'pages/index.vue' } });
    expect(m.action).toBe('Edited');
    expect(m.filePath).toBe('pages/index.vue');
    expect(m.toolName).toBe('edit_file');
  });
  it('treats a bash tool as Executed and surfaces the command as the path', () => {
    // extractPathFromInput picks up the command for Executed actions, so it
    // becomes filePath (the separate `command` field is only used as a fallback).
    const m = buildToolMetadata({ name: 'bash', input: { command: 'ls -la' } });
    expect(m.action).toBe('Executed');
    expect(m.filePath).toBe('ls -la');
  });
  it('captures a summary when present', () => {
    const m = buildToolMetadata({ name: 'read_file', input: { path: 'a.ts' }, summary: 'read the file' });
    expect(m.action).toBe('Read');
    expect(m.summary).toBe('read the file');
  });
});
