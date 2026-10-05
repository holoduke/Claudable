'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { FaPuzzlePiece, FaTimes, FaSearch } from 'react-icons/fa';
import { useI18n } from '@/contexts/I18nContext';

interface Skill {
  id: string;
  name: string;
  description: string;
  scope: 'project' | 'global';
  enabled: boolean;
}

interface SkillsModalProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export default function SkillsModal({ projectId, isOpen, onClose }: SkillsModalProps) {
  const { t } = useI18n();
  const titleId = useId();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/skills`, { cache: 'no-store' });
      const json = await res.json();
      const data = json?.data ?? {};
      const project: Skill[] = Array.isArray(data.project) ? data.project : [];
      const global: Skill[] = Array.isArray(data.global) ? data.global : [];
      setSkills([...project, ...global]);
    } catch {
      setError(t('chat.skills.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  // Clear the search each time the modal opens (adjusted during render).
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setQuery('');
  }

  useEffect(() => {
    if (isOpen) {
      load();
    }
  }, [isOpen, load]);

  const toggle = useCallback(
    async (skill: Skill) => {
      const next = !skill.enabled;
      setPending((p) => ({ ...p, [skill.id]: true }));
      // optimistic
      setSkills((list) => list.map((s) => (s.id === skill.id ? { ...s, enabled: next } : s)));
      try {
        const res = await fetch(
          `${API_BASE}/api/projects/${projectId}/skills/${encodeURIComponent(skill.id)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          },
        );
        if (!res.ok) throw new Error();
      } catch {
        // revert on failure
        setSkills((list) => list.map((s) => (s.id === skill.id ? { ...s, enabled: skill.enabled } : s)));
        setError(t('chat.skills.updateFailed', { name: skill.name }));
      } finally {
        setPending((p) => {
          const { [skill.id]: _, ...rest } = p;
          return rest;
        });
      }
    },
    [projectId, t],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      : skills;
    return list;
  }, [skills, query]);

  const enabledCount = skills.filter((s) => s.enabled).length;

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#181310] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-white/8 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FaPuzzlePiece className="text-gray-700 dark:text-gray-200" size={15} aria-hidden="true" />
            <h3 id={titleId} className="text-base font-semibold text-gray-900 dark:text-gray-50">{t('chat.skills.title')}</h3>
            <span className="rounded-full bg-gray-100 dark:bg-white/6 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300">
              {t('chat.skills.activeCount', { count: enabledCount })}
            </span>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300" aria-label={t('common.close')}>
            <FaTimes size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-gray-100 dark:border-white/8 px-6 py-3">
          <div className="relative">
            <FaSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" size={13} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('chat.skills.searchPlaceholder')}
              aria-label={t('chat.skills.searchAria')}
              className="w-full rounded-lg border border-gray-300 dark:border-white/8 py-2 pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
            {t('chat.skills.hint')}
          </p>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {error && <p className="px-3 py-2 text-xs text-red-600">{error}</p>}
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-400 dark:text-gray-500">
              {skills.length === 0 ? t('chat.skills.none') : t('chat.skills.noMatch')}
            </p>
          ) : (
            <ul className="flex flex-col">
              {filtered.map((s) => (
                <li key={`${s.scope}:${s.id}`}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-white/6 ${
                      pending[s.id] ? 'opacity-60' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={!!pending[s.id]}
                      onChange={() => toggle(s)}
                      className="mt-0.5 size-4 shrink-0 rounded-sm border-gray-300 dark:border-white/8 text-brand-500 focus:ring-brand-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-mono text-sm font-medium text-gray-900 dark:text-gray-50">{s.name}</span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            s.scope === 'global'
                              ? 'bg-violet-100 text-violet-700'
                              : 'bg-brand-500/15 text-brand-500'
                          }`}
                        >
                          {s.scope === 'global' ? t('chat.skills.scopeGlobal') : t('chat.skills.scopeProject')}
                        </span>
                      </span>
                      {s.description && (
                        <span className="mt-0.5 line-clamp-2 block text-xs text-gray-500 dark:text-gray-400">{s.description}</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
