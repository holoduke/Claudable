import React from 'react';

/**
 * Dependency-free colored diff renderer for tool-call expansions.
 *
 * Accepts either a unified-diff/patch string or one-or-more old/new text
 * segments (Edit / MultiEdit / Write inputs) and renders +/- gutter lines.
 */

export interface DiffSegment {
  oldText: string;
  newText: string;
}

export interface DiffData {
  /** A unified-diff / patch string (e.g. codex apply_patch input). */
  patch?: string;
  /** One or more old/new pairs (Edit → one, MultiEdit → many, Write → old=''). */
  segments?: DiffSegment[];
}

type LineKind = 'add' | 'del' | 'context' | 'hunk';
interface DiffLine {
  kind: LineKind;
  text: string;
}

const MAX_RENDER_LINES = 400;
// Guard against O(n*m) LCS blowing up on very large edits.
const MAX_LCS_LINES = 1500;

const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
};

const asTrimmedString = (value: unknown): string | undefined => {
  const s = asString(value);
  if (s === undefined) return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
};

/**
 * Derive renderable diff data from a persisted tool input. Returns null when the
 * input carries no old/new/patch content (e.g. reads, bash, searches).
 */
export const extractDiffData = (
  toolInput: unknown,
  action?: string
): DiffData | null => {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;

  // Unified patch string (codex apply_patch / generic diff).
  const patch =
    asTrimmedString(input.patch) ??
    asTrimmedString(input.diff) ??
    (typeof input.input === 'string' && /^[-+@]/m.test(input.input) ? input.input : undefined);
  if (patch && /^[-+@]/m.test(patch)) {
    return { patch };
  }

  // MultiEdit: an array of { old_string, new_string } edits.
  if (Array.isArray(input.edits)) {
    const segments: DiffSegment[] = [];
    for (const raw of input.edits) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      const oldText = asString(e.old_string) ?? asString(e.oldText) ?? asString(e.oldStr) ?? '';
      const newText = asString(e.new_string) ?? asString(e.newText) ?? asString(e.newStr) ?? '';
      if (oldText.length > 0 || newText.length > 0) {
        segments.push({ oldText, newText });
      }
    }
    if (segments.length > 0) return { segments };
  }

  // Single Edit: old_string / new_string.
  const oldText = asString(input.old_string) ?? asString(input.oldText) ?? asString(input.oldStr);
  const newText = asString(input.new_string) ?? asString(input.newText) ?? asString(input.newStr);
  if (oldText !== undefined || newText !== undefined) {
    return { segments: [{ oldText: oldText ?? '', newText: newText ?? '' }] };
  }

  // Write / create: whole content is new (rendered as all-additions).
  if (action === 'Created' || action === 'Edited') {
    const content =
      asString(input.content) ??
      asString(input.contents) ??
      asString(input.text) ??
      asString(input.file_text);
    if (content !== undefined && content.length > 0) {
      return { segments: [{ oldText: '', newText: content }] };
    }
  }

  return null;
};

/** Line-level diff of two strings. LCS-based; naive fallback for huge inputs. */
const lineDiff = (oldText: string, newText: string): DiffLine[] => {
  const a = oldText.length > 0 ? oldText.split('\n') : [];
  const b = newText.length > 0 ? newText.split('\n') : [];
  const m = a.length;
  const n = b.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return b.map((text) => ({ kind: 'add' as const, text }));
  if (n === 0) return a.map((text) => ({ kind: 'del' as const, text }));

  // Fallback for very large inputs: show removed block then added block.
  if (m > MAX_LCS_LINES || n > MAX_LCS_LINES) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ];
  }

  // LCS length table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', text: a[i++] });
  while (j < n) out.push({ kind: 'add', text: b[j++] });
  return out;
};

/** Classify the lines of a unified-diff / patch string. */
const parsePatch = (patch: string): DiffLine[] =>
  patch.split('\n').map((text) => {
    if (text.startsWith('@@')) return { kind: 'hunk', text };
    if (text.startsWith('+++') || text.startsWith('---')) return { kind: 'context', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    return { kind: 'context', text };
  });

const buildLines = (diff: DiffData): DiffLine[] => {
  if (diff.patch) return parsePatch(diff.patch);
  if (diff.segments && diff.segments.length > 0) {
    const lines: DiffLine[] = [];
    diff.segments.forEach((seg, idx) => {
      if (idx > 0) lines.push({ kind: 'hunk', text: '@@ ' + '…' + ' @@' });
      lines.push(...lineDiff(seg.oldText, seg.newText));
    });
    return lines;
  }
  return [];
};

const GUTTER: Record<LineKind, string> = {
  add: '+',
  del: '-',
  context: ' ',
  hunk: ' ',
};

const LINE_CLASS: Record<LineKind, string> = {
  add: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  del: 'bg-red-500/10 text-red-700 dark:text-red-300',
  context: 'text-gray-500 dark:text-gray-400',
  hunk: 'text-sky-600 dark:text-sky-400 bg-sky-500/5',
};

interface DiffViewProps {
  diff: DiffData;
}

const DiffView: React.FC<DiffViewProps> = ({ diff }) => {
  const allLines = buildLines(diff);
  const truncated = allLines.length > MAX_RENDER_LINES;
  const lines = truncated ? allLines.slice(0, MAX_RENDER_LINES) : allLines;
  const hidden = allLines.length - lines.length;

  if (lines.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-white/[0.08]">
      <div className="min-w-full font-mono text-xs leading-relaxed">
        {lines.map((line, idx) => (
          <div key={idx} className={`flex whitespace-pre ${LINE_CLASS[line.kind]}`}>
            <span
              className="select-none w-4 shrink-0 pl-1 text-center opacity-60"
              aria-hidden="true"
            >
              {GUTTER[line.kind]}
            </span>
            <span className="pr-3 break-words">{line.text || ' '}</span>
          </div>
        ))}
      </div>
      {truncated && (
        <div className="px-2 py-1 text-[11px] text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-white/[0.08]">
          {'…'}{hidden} more line{hidden === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
};

export default DiffView;
