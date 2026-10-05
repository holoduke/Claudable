"use client";
import { useEffect, useId, useMemo, useState } from 'react';
import { useT } from '@/contexts/I18nContext';

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
  const t = useT();
  const titleId = useId();
  const [catalog, setCatalog] = useState<DesignEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed catalog load gets its own state with a retry — it must not read
  // as "No designs match".
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [loadKey, setLoadKey] = useState({ isOpen, attempt });

  // Show the loading state again every time the modal (re)opens or retries —
  // adjusted during render instead of in the effect below.
  if (isOpen !== loadKey.isOpen || attempt !== loadKey.attempt) {
    setLoadKey({ isOpen, attempt });
    if (isOpen) { setLoading(true); setLoadFailed(false); }
  }

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    fetch(`${API_BASE}/api/design-skills`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (controller.signal.aborted) return;
        if (j?.success && Array.isArray(j.data)) setCatalog(j.data as DesignEntry[]);
        else setLoadFailed(true);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        console.warn('Failed to load design styles:', e);
        setLoadFailed(true);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [isOpen, attempt]);

  // Escape closes the dialog.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

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
    <div className="fixed inset-0 z-300 flex items-center justify-center p-4">
      <div aria-hidden className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-4xl h-[80vh] border border-gray-200 dark:border-gray-700 flex flex-col">
        <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-gray-50">{t('home.design.title')}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('home.design.subtitle')}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')} className="p-1 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">
            <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('home.design.search')}
            aria-label={t('home.design.search')}
            autoFocus
            className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-blue-200"
          />
          <button
            type="button"
            onClick={() => pick(null)}
            className={`px-3 py-2 text-sm font-medium rounded-lg border whitespace-nowrap ${
              selectedId === null ? 'border-blue-500 text-blue-700 bg-blue-50' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            {t('home.design.none')}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div role="status" className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">{t('home.design.loading')}</div>
          ) : loadFailed ? (
            <div role="alert" className="py-10 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-gray-600 dark:text-gray-300">{t('home.design.loadError')}</p>
              <button
                type="button"
                onClick={() => setAttempt((a) => a + 1)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-500 hover:bg-brand-600 text-white"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {filtered.map((d) => {
                const selected = d.id === selectedId;
                return (
                  <button
                    type="button"
                    key={d.id}
                    onClick={() => pick(d)}
                    title={d.description}
                    className={`group text-left rounded-xl border overflow-hidden transition-all ${
                      selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                  >
                    <div className="aspect-4/3 bg-gray-100 dark:bg-gray-800 overflow-hidden relative">
                      {d.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={d.preview} alt={d.name} loading="lazy" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500 text-xs">{t('home.design.noPreview')}</div>
                      )}
                    </div>
                    <div className="p-2">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{d.name}</p>
                    </div>
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className="col-span-full py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                  {catalog.length === 0 ? t('home.design.empty') : t('home.design.noMatch', { query: query.trim() })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
