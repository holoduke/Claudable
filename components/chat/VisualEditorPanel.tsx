"use client";
import { useMemo } from 'react';

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

// Grouped, curated CSS controls. `kind` picks the input widget.
const GROUPS: { title: string; fields: { prop: string; label: string; kind: 'text' | 'color' | 'select'; options?: string[] }[] }[] = [
  {
    title: 'Typography',
    fields: [
      { prop: 'color', label: 'Text color', kind: 'color' },
      { prop: 'fontSize', label: 'Font size', kind: 'text' },
      { prop: 'fontWeight', label: 'Font weight', kind: 'text' },
      { prop: 'lineHeight', label: 'Line height', kind: 'text' },
      { prop: 'letterSpacing', label: 'Letter spacing', kind: 'text' },
      { prop: 'textAlign', label: 'Text align', kind: 'select', options: ['left', 'center', 'right', 'justify'] },
    ],
  },
  {
    title: 'Background & border',
    fields: [
      { prop: 'backgroundColor', label: 'Background', kind: 'color' },
      { prop: 'borderRadius', label: 'Radius', kind: 'text' },
      { prop: 'borderWidth', label: 'Border width', kind: 'text' },
      { prop: 'borderColor', label: 'Border color', kind: 'color' },
    ],
  },
  {
    title: 'Spacing & size',
    fields: [
      { prop: 'padding', label: 'Padding', kind: 'text' },
      { prop: 'margin', label: 'Margin', kind: 'text' },
      { prop: 'width', label: 'Width', kind: 'text' },
      { prop: 'height', label: 'Height', kind: 'text' },
      { prop: 'display', label: 'Display', kind: 'select', options: ['block', 'inline', 'inline-block', 'flex', 'grid', 'none'] },
      { prop: 'opacity', label: 'Opacity', kind: 'text' },
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
  const val = (prop: string) => (prop in edits ? edits[prop] : element?.styles[prop] ?? '');
  const dirtyCount = useMemo(
    () => Object.keys(edits).length + (textEdit !== null ? 1 : 0),
    [edits, textEdit],
  );

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex items-center justify-between px-4 h-[73px] border-b border-gray-200">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-[#DE7356]" />
          <span className="font-semibold text-gray-900">Visual editor</span>
        </div>
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-800 px-2 py-1 rounded hover:bg-gray-100">Done</button>
      </div>

      {!element ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 text-gray-500">
          <div className="text-4xl mb-3">🎯</div>
          <p className="font-medium text-gray-700">Click any element in the preview</p>
          <p className="text-sm mt-1">Then tweak its text, colors, spacing and more — changes apply live.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Selected element summary */}
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono bg-[#DE7356]/10 text-[#DE7356] px-1.5 py-0.5 rounded">{element.tag}</span>
              {element.id && <span className="text-xs font-mono text-gray-500">#{element.id}</span>}
              {element.classes.slice(0, 4).map((c) => (
                <span key={c} className="text-xs font-mono text-gray-400">.{c}</span>
              ))}
            </div>
            <div className="text-[11px] font-mono text-gray-400 mt-1 truncate" title={element.selector}>{element.selector}</div>
          </div>

          {/* Text content */}
          {element.editableText && (
            <div className="px-4 py-3 border-b border-gray-100">
              <label className="block text-xs font-medium text-gray-500 mb-1">Text</label>
              <textarea
                value={textEdit !== null ? textEdit : element.text}
                onChange={(e) => onApplyText(e.target.value)}
                rows={2}
                className="w-full text-sm border border-gray-200 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-[#DE7356]/30"
              />
            </div>
          )}

          {/* Style groups */}
          {GROUPS.map((g) => (
            <div key={g.title} className="px-4 py-3 border-b border-gray-100">
              <div className="text-xs font-medium text-gray-500 mb-2">{g.title}</div>
              <div className="grid grid-cols-2 gap-2">
                {g.fields.map((f) => (
                  <div key={f.prop} className="flex flex-col gap-1">
                    <label className="text-[11px] text-gray-400">{f.label}</label>
                    {f.kind === 'select' ? (
                      <select
                        value={val(f.prop)}
                        onChange={(e) => onApplyStyle(f.prop, e.target.value)}
                        className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-[#DE7356]/40"
                      >
                        <option value="">—</option>
                        {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : f.kind === 'color' ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="color"
                          value={toHex(val(f.prop))}
                          onChange={(e) => onApplyStyle(f.prop, e.target.value)}
                          className="w-7 h-7 rounded border border-gray-200 p-0 cursor-pointer shrink-0"
                        />
                        <input
                          type="text"
                          value={val(f.prop)}
                          onChange={(e) => onApplyStyle(f.prop, e.target.value)}
                          className="min-w-0 flex-1 text-xs border border-gray-200 rounded px-1.5 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-[#DE7356]/40"
                        />
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={val(f.prop)}
                        onChange={(e) => onApplyStyle(f.prop, e.target.value)}
                        className="text-xs border border-gray-200 rounded px-1.5 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-[#DE7356]/40"
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
      <div className="border-t border-gray-200 p-3">
        <button
          onClick={onPersist}
          disabled={!element || dirtyCount === 0 || persisting || busy}
          title={busy ? 'The agent is busy — apply once it finishes' : undefined}
          className="w-full h-9 rounded-lg bg-[#DE7356] text-white text-sm font-medium hover:bg-[#c65f43] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Agent busy…' : persisting ? 'Applying…' : dirtyCount === 0 ? 'No changes yet' : `Apply ${dirtyCount} change${dirtyCount > 1 ? 's' : ''} to code`}
        </button>
        <p className="text-[11px] text-gray-400 mt-2 text-center">
          Live changes are preview-only until applied to code (via the agent).
        </p>
      </div>
    </div>
  );
}
