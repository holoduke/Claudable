"use client";
import { useId, useMemo } from 'react';
import { useI18n } from '@/contexts/I18nContext';
import type { MessageKey } from '@/lib/i18n/messages/en';

export interface SelectedElement {
  selector: string;
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  editableText: boolean;
  styles: Record<string, string>;
}

interface VisualEditorPanelProps {
  element: SelectedElement | null;
  /** Current per-property edits for the selected element (prop -> value). */
  edits: Record<string, string>;
  textEdit: string | null;
  onApplyStyle: (prop: string, value: string) => void;
  onApplyText: (value: string) => void;
  onPersist: () => void;
  onClose: () => void;
  persisting?: boolean;
  /** An agent turn is running — block "Apply to code" (it would launch another). */
  busy?: boolean;
}

// Grouped, curated CSS controls. `kind` picks the input widget. `title` and
// `label` are i18n keys (chat.visual.*).
const GROUPS: { title: MessageKey; fields: { prop: string; label: MessageKey; kind: 'text' | 'color' | 'select'; options?: string[] }[] }[] = [
  {
    title: 'chat.visual.group.typography',
    fields: [
      { prop: 'color', label: 'chat.visual.field.color', kind: 'color' },
      { prop: 'fontSize', label: 'chat.visual.field.fontSize', kind: 'text' },
      { prop: 'fontWeight', label: 'chat.visual.field.fontWeight', kind: 'text' },
      { prop: 'lineHeight', label: 'chat.visual.field.lineHeight', kind: 'text' },
      { prop: 'letterSpacing', label: 'chat.visual.field.letterSpacing', kind: 'text' },
      { prop: 'textAlign', label: 'chat.visual.field.textAlign', kind: 'select', options: ['left', 'center', 'right', 'justify'] },
    ],
  },
  {
    title: 'chat.visual.group.background',
    fields: [
      { prop: 'backgroundColor', label: 'chat.visual.field.backgroundColor', kind: 'color' },
      { prop: 'borderRadius', label: 'chat.visual.field.borderRadius', kind: 'text' },
      { prop: 'borderWidth', label: 'chat.visual.field.borderWidth', kind: 'text' },
      { prop: 'borderColor', label: 'chat.visual.field.borderColor', kind: 'color' },
    ],
  },
  {
    title: 'chat.visual.group.spacing',
    fields: [
      { prop: 'padding', label: 'chat.visual.field.padding', kind: 'text' },
      { prop: 'margin', label: 'chat.visual.field.margin', kind: 'text' },
      { prop: 'width', label: 'chat.visual.field.width', kind: 'text' },
      { prop: 'height', label: 'chat.visual.field.height', kind: 'text' },
      { prop: 'display', label: 'chat.visual.field.display', kind: 'select', options: ['block', 'inline', 'inline-block', 'flex', 'grid', 'none'] },
      { prop: 'opacity', label: 'chat.visual.field.opacity', kind: 'text' },
    ],
  },
];

/** rgb(a) → #hex so <input type=color> can show it; passes through hex/names. */
function toHex(value: string | undefined): string {
  if (!value) return '#000000';
  const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/u);
  if (m) {
    const h = (n: string) => Number(n).toString(16).padStart(2, '0');
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }
  return /^#[0-9a-f]{6}$/iu.test(value) ? value : '#000000';
}

export default function VisualEditorPanel({
  element, edits, textEdit, onApplyStyle, onApplyText, onPersist, onClose, persisting, busy = false,
}: VisualEditorPanelProps) {
  const { t } = useI18n();
  const baseId = useId();
  const fieldId = (prop: string) => `${baseId}-${prop}`;
  const val = (prop: string) => (prop in edits ? edits[prop] : element?.styles[prop] ?? '');
  const dirtyCount = useMemo(
    () => Object.keys(edits).length + (textEdit !== null ? 1 : 0),
    [edits, textEdit],
  );

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#0c0a09]">
      <div className="flex items-center justify-between px-4 h-[73px] border-b border-gray-200 dark:border-white/8">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-brand-500" />
          <span className="font-semibold text-gray-900 dark:text-gray-50">{t('chat.visual.title')}</span>
        </div>
        <button onClick={onClose} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 px-2 py-1 rounded-sm hover:bg-gray-100 dark:hover:bg-white/6">{t('chat.visual.done')}</button>
      </div>

      {!element ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 text-gray-500 dark:text-gray-400">
          <div className="text-4xl mb-3">🎯</div>
          <p className="font-medium text-gray-700 dark:text-gray-200">{t('chat.visual.emptyTitle')}</p>
          <p className="text-sm mt-1">{t('chat.visual.emptyBody')}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Selected element summary */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-white/8 bg-gray-50 dark:bg-white/3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono bg-brand-500/10 text-brand-500 px-1.5 py-0.5 rounded-sm">{element.tag}</span>
              {element.id && <span className="text-xs font-mono text-gray-500 dark:text-gray-400">#{element.id}</span>}
              {element.classes.slice(0, 4).map((c) => (
                <span key={c} className="text-xs font-mono text-gray-400 dark:text-gray-500">.{c}</span>
              ))}
            </div>
            <div className="text-[11px] font-mono text-gray-400 dark:text-gray-500 mt-1 truncate" title={element.selector}>{element.selector}</div>
          </div>

          {/* Text content */}
          {element.editableText && (
            <div className="px-4 py-3 border-b border-gray-100 dark:border-white/8">
              <label htmlFor={fieldId('text')} className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t('chat.visual.text')}</label>
              <textarea
                id={fieldId('text')}
                value={textEdit !== null ? textEdit : element.text}
                onChange={(e) => onApplyText(e.target.value)}
                rows={2}
                className="w-full text-sm border border-gray-200 dark:border-white/8 rounded-md p-2 focus:outline-hidden focus:ring-2 focus:ring-brand-500/30"
              />
            </div>
          )}

          {/* Style groups */}
          {GROUPS.map((g) => (
            <div key={g.title} className="px-4 py-3 border-b border-gray-100 dark:border-white/8">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{t(g.title)}</div>
              <div className="grid grid-cols-2 gap-2">
                {g.fields.map((f) => (
                  <div key={f.prop} className="flex flex-col gap-1">
                    <label htmlFor={fieldId(f.prop)} className="text-[11px] text-gray-400 dark:text-gray-500">{t(f.label)}</label>
                    {f.kind === 'select' ? (
                      <select
                        id={fieldId(f.prop)}
                        value={val(f.prop)}
                        onChange={(e) => onApplyStyle(f.prop, e.target.value)}
                        className="text-xs border border-gray-200 dark:border-white/8 rounded-sm px-1.5 py-1 bg-white dark:bg-white/6 focus:outline-hidden focus:ring-1 focus:ring-brand-500/40"
                      >
                        <option value="">—</option>
                        {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : f.kind === 'color' ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="color"
                          aria-label={t('chat.visual.colorPicker', { label: t(f.label) })}
                          value={toHex(val(f.prop))}
                          onChange={(e) => onApplyStyle(f.prop, e.target.value)}
                          className="w-7 h-7 rounded-sm border border-gray-200 dark:border-white/8 p-0 cursor-pointer shrink-0"
                        />
                        <input
                          id={fieldId(f.prop)}
                          type="text"
                          value={val(f.prop)}
                          onChange={(e) => onApplyStyle(f.prop, e.target.value)}
                          className="min-w-0 flex-1 text-xs border border-gray-200 dark:border-white/8 rounded-sm px-1.5 py-1 font-mono focus:outline-hidden focus:ring-1 focus:ring-brand-500/40"
                        />
                      </div>
                    ) : (
                      <input
                        id={fieldId(f.prop)}
                        type="text"
                        value={val(f.prop)}
                        onChange={(e) => onApplyStyle(f.prop, e.target.value)}
                        className="text-xs border border-gray-200 dark:border-white/8 rounded-sm px-1.5 py-1 font-mono focus:outline-hidden focus:ring-1 focus:ring-brand-500/40"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Persist */}
      <div className="border-t border-gray-200 dark:border-white/8 p-3">
        <button
          onClick={onPersist}
          disabled={!element || dirtyCount === 0 || persisting || busy}
          title={busy ? t('chat.visual.busyTitle') : undefined}
          className="w-full h-9 rounded-lg bg-brand-500 text-white text-sm font-medium hover:bg-brand-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? t('chat.visual.busy') : persisting ? t('chat.visual.applying') : dirtyCount === 0 ? t('chat.visual.noChanges') : t(dirtyCount > 1 ? 'chat.visual.apply.other' : 'chat.visual.apply.one', { count: dirtyCount })}
        </button>
        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2 text-center">
          {t('chat.visual.hint')}
        </p>
      </div>
    </div>
  );
}
