/**
 * Pending visual-editor edits, kept PER ELEMENT (keyed by CSS selector) so
 * selecting another element in the preview never drops edits made earlier.
 * Pure + immutable: every update returns a new map.
 */
import type { SelectedElement } from '@/components/chat/VisualEditorPanel';

export interface PendingElementEdit {
  element: SelectedElement;
  styles: Record<string, string>;
  /** null = text untouched. */
  text: string | null;
}

export type PendingEdits = Record<string, PendingElementEdit>;

function entryFor(edits: PendingEdits, element: SelectedElement): PendingElementEdit {
  return edits[element.selector] ?? { element, styles: {}, text: null };
}

export function withStyleEdit(edits: PendingEdits, element: SelectedElement, prop: string, value: string): PendingEdits {
  const entry = entryFor(edits, element);
  return { ...edits, [element.selector]: { ...entry, styles: { ...entry.styles, [prop]: value } } };
}

export function withTextEdit(edits: PendingEdits, element: SelectedElement, value: string): PendingEdits {
  const entry = entryFor(edits, element);
  return { ...edits, [element.selector]: { ...entry, text: value } };
}

/** Number of changes for one element (each style prop + the text counts once). */
export function countElementEdits(entry: PendingElementEdit | undefined): number {
  if (!entry) return 0;
  const textChanged = entry.text !== null && entry.text !== entry.element.text;
  return Object.keys(entry.styles).length + (textChanged ? 1 : 0);
}

export function countPendingEdits(edits: PendingEdits): number {
  return Object.values(edits).reduce((sum, e) => sum + countElementEdits(e), 0);
}

export function countEditedElements(edits: PendingEdits): number {
  return Object.values(edits).filter((e) => countElementEdits(e) > 0).length;
}

function describeElement(el: SelectedElement): string {
  const id = el.id ? ` #${el.id}` : '';
  const classes = el.classes.length ? ` .${el.classes.join('.')}` : '';
  return `<${el.tag}>${id}${classes}`;
}

function elementBlock(entry: PendingElementEdit, index: number): string {
  const { element } = entry;
  const styleLines = Object.entries(entry.styles).map(([k, v]) => `  - ${k}: ${v}`);
  const textChanged = entry.text !== null && entry.text !== element.text;
  return [
    `${index}. Element: ${describeElement(element)}`,
    `   CSS selector: ${element.selector}`,
    element.text ? `   Current text: "${element.text.slice(0, 100)}"` : '',
    textChanged ? `   New text: "${entry.text}"` : '',
    styleLines.length ? `   Style changes:\n${styleLines.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

/** Agent instruction that persists every pending element edit; '' when none. */
export function buildPersistInstruction(edits: PendingEdits): string {
  const entries = Object.values(edits).filter((e) => countElementEdits(e) > 0);
  if (!entries.length) return '';
  return [
    'Visual edit — persist these preview-only changes into the source code:',
    '',
    ...entries.map((e, i) => elementBlock(e, i + 1)),
    '',
    'Locate each element in the source (match the selector / tag / classes) and apply the change idiomatically — prefer Tailwind classes or scoped styles as fits the codebase. Keep the diff minimal.',
  ].join('\n');
}
