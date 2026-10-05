import { describe, it, expect } from 'vitest';
import {
  withStyleEdit, withTextEdit, countPendingEdits, countEditedElements, countElementEdits,
  buildPersistInstruction, type PendingEdits,
} from './chatpage-visual-edits';
import { isBinaryPath, looksBinaryContent, lockPlaceholder } from './chatpage-file-view';
import { readPostCreateNotice } from './chatpage-notice';
import type { SelectedElement } from '@/components/chat/VisualEditorPanel';

const el = (selector: string, text = 'Hi'): SelectedElement => ({
  selector, tag: 'p', id: null, classes: ['a'], text, editableText: true, styles: {},
});

describe('visual edits per element', () => {
  it('keeps edits for earlier elements when another is edited', () => {
    let e: PendingEdits = {};
    e = withStyleEdit(e, el('#one'), 'color', 'red');
    e = withStyleEdit(e, el('#two'), 'fontSize', '20px');
    e = withTextEdit(e, el('#two'), 'Bye');
    expect(countPendingEdits(e)).toBe(3);
    expect(countEditedElements(e)).toBe(2);
    expect(e['#one'].styles.color).toBe('red');
  });

  it('does not mutate the previous map', () => {
    const a: PendingEdits = {};
    const b = withStyleEdit(a, el('#x'), 'color', 'red');
    expect(a).toEqual({});
    expect(b).not.toBe(a);
  });

  it('does not count text equal to the original', () => {
    const e = withTextEdit({}, el('#x', 'Same'), 'Same');
    expect(countElementEdits(e['#x'])).toBe(0);
    expect(buildPersistInstruction(e)).toBe('');
  });

  it('builds one instruction covering every element', () => {
    let e: PendingEdits = {};
    e = withStyleEdit(e, el('#one'), 'color', 'red');
    e = withTextEdit(e, el('#two'), 'New');
    const s = buildPersistInstruction(e);
    expect(s).toContain('#one');
    expect(s).toContain('color: red');
    expect(s).toContain('New text: "New"');
    expect(s).toContain('#two');
  });
});

describe('file view locks', () => {
  it('detects binary extensions', () => {
    expect(isBinaryPath('public/logo.PNG')).toBe(true);
    expect(isBinaryPath('fonts/a.woff2')).toBe(true);
    expect(isBinaryPath('src/app.ts')).toBe(false);
    expect(isBinaryPath('.env')).toBe(false);
    expect(isBinaryPath('Makefile')).toBe(false);
  });

  it('detects NUL bytes', () => {
    expect(looksBinaryContent('abc\u0000def')).toBe(true);
    expect(looksBinaryContent('plain text')).toBe(false);
  });

  it('renders placeholders', () => {
    const labels = { error: (m: string) => `ERR ${m}`, binary: 'BIN' };
    expect(lockPlaceholder({ kind: 'error', message: 'too large' }, labels)).toBe('ERR too large');
    expect(lockPlaceholder({ kind: 'binary' }, labels)).toBe('BIN');
    expect(lockPlaceholder({ kind: 'readonly' }, labels)).toBeNull();
  });
});

describe('post-create notice', () => {
  it('parses a valid notice', () => {
    expect(readPostCreateNotice('{"type":"error","message":"x"}')).toEqual({ type: 'error', message: 'x' });
  });
  it('rejects junk', () => {
    expect(readPostCreateNotice(null)).toBeNull();
    expect(readPostCreateNotice('not json')).toBeNull();
    expect(readPostCreateNotice('{"type":"warn","message":"x"}')).toBeNull();
    expect(readPostCreateNotice('{"type":"info","message":"  "}')).toBeNull();
  });
});
