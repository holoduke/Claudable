"use client";
import { useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface DesignEntry {
  id: string;
  name: string;
  description: string;
  preview: string | null;
}

interface Props {
  isOpen: boolean;
  selectedId: string | null;
  onClose: () => void;
  onSelect: (design: { id: string; name: string } | null) => void;
}

/**
 * Start-screen design picker. Selection-only — it returns the chosen design to
 * the caller (no project exists yet); the design is applied when the project is
 * created. The in-project "Design" settings tab uses its own component.
 */
export default function DesignPickerModal({ isOpen, selectedId, onClose, onSelect }: Props) {
  const [catalog, setCatalog] = useState<DesignEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/api/design-skills`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j.success) setCatalog(j.data as DesignEntry[]); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
  }, [catalog, query]);

  if (!isOpen) return null;

  const pick = (d: DesignEntry | null) => {
    onSelect(d ? { id: d.id, name: d.name } : null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl h-[80vh] border border-gray-200 flex flex-col">
        <div className="p-5 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Choose a design style</h2>
            <p className="text-sm text-gray-500">The agent will style your new project with it. You can change it later in Project Settings → Design.</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="p-4 border-b border-gray-200 flex items-center gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search designs…"
            className="flex-1 px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-200"
          />
          <button
            onClick={() => pick(null)}
            className={`px-3 py-2 text-sm font-medium rounded-lg border whitespace-nowrap ${
              selectedId === null ? 'border-blue-500 text-blue-700 bg-blue-50' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            No design
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="py-10 text-center text-sm text-gray-500">Loading designs…</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {filtered.map((d) => {
                const selected = d.id === selectedId;
                return (
                  <button
                    key={d.id}
                    onClick={() => pick(d)}
                    title={d.description}
                    className={`group text-left rounded-xl border overflow-hidden transition-all ${
                      selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="aspect-[4/3] bg-gray-100 overflow-hidden relative">
                      {d.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={d.preview} alt={d.name} loading="lazy" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">No preview</div>
                      )}
                    </div>
                    <div className="p-2">
                      <p className="text-sm font-medium text-gray-900 truncate">{d.name}</p>
                    </div>
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className="col-span-full py-8 text-center text-sm text-gray-400">No designs match “{query}”.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
