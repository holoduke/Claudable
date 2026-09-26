"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/contexts/I18nContext';
import { useToast } from '@/components/ui/Toast';
import type { UseProjectBranches } from '@/hooks/useProjectBranches';

interface BranchSwitcherProps {
  branches: UseProjectBranches;
  /** Blocks every action (an agent turn or request is running in this tab). */
  busy: boolean;
  /** The working tree changed (switch): reload the preview + file tree. */
  onTreeChanged: () => void;
  /** Merge the current branch into the base branch (page follows the deploy). */
  onMerge: () => Promise<void>;
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

function BranchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/**
 * Toolbar branch menu (left of Publish): switch branch, create one, merge the
 * current branch into the base branch. All server-side safety (commit pending
 * work, refuse during an agent turn, customer guard) lives in git-branches.ts;
 * this only drives it and reports the outcome.
 */
export default function BranchSwitcher({ branches, busy, onTreeChanged, onMerge }: BranchSwitcherProps) {
  const t = useT();
  const toast = useToast();
  const { data, refresh, act } = branches;
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Opening refreshes the list; closing resets the inline create/merge forms.
  const setMenu = useCallback((next: boolean) => {
    setOpen(next);
    if (next) void refresh();
    else { setCreating(false); setNewName(''); setConfirmMerge(false); }
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, setMenu]);


  if (!data) return null;

  const blocked = busy || data.agent_busy || working !== null;
  const nameValid = BRANCH_RE.test(newName.trim()) && !newName.includes('..');
  const onBase = data.current === data.base;

  const run = async (label: string, fn: () => Promise<void>) => {
    setWorking(label);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('branch.failed'));
    } finally {
      setWorking(null);
      void refresh();
    }
  };

  const switchTo = (name: string) => run(t('branch.switching', { branch: name }), async () => {
    const r = await act('git/checkout', { branch: name });
    setMenu(false);
    if (r.preview_error) toast.error(t('branch.previewRestartFailed', { error: r.preview_error }));
    else toast.success(t('branch.switched', { branch: name }));
    if (r.diverged) toast.info(t('branch.diverged', { branch: name }));
    if (r.changed_files > 0) onTreeChanged();
  });

  const create = () => run(t('branch.creating'), async () => {
    const name = newName.trim();
    await act('git/branches', { name });
    setMenu(false);
    toast.success(t('branch.created', { branch: name }));
  });

  const merge = async () => {
    setWorking(t('branch.merging'));
    try {
      setMenu(false);
      await onMerge(); // reports its own outcome and errors
    } finally {
      setWorking(null);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setMenu(!open)}
        title={t('branch.buttonTitle')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-9 flex items-center gap-1.5 px-2.5 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 transition-colors text-sm"
      >
        {working ? (
          <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-gray-600 dark:border-white/20 dark:border-t-white rounded-full animate-spin" aria-hidden="true" />
        ) : (
          <BranchIcon />
        )}
        <span className="max-w-[9rem] truncate font-medium">{data.current}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 w-80 max-w-[calc(100vw-2rem)] z-50 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1c1714] shadow-xl py-1.5 text-sm">
          <div className="px-3 pt-1 pb-2 text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{t('branch.heading')}</div>

          {(data.agent_busy || busy) && (
            <p className="mx-3 mb-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">{t('branch.agentBusy')}</p>
          )}

          <div className="max-h-64 overflow-y-auto">
            {data.branches.map((b) => (
              <button
                key={b.name}
                role="menuitemradio"
                aria-checked={b.current}
                disabled={blocked || b.current}
                onClick={() => switchTo(b.name)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:cursor-default ${
                  b.current ? 'text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 disabled:opacity-50'
                }`}
              >
                <span className="w-4 shrink-0 text-brand-500">{b.current ? '✓' : ''}</span>
                <span className="truncate flex-1" title={b.name}>{b.name}</span>
                {b.base && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300">{t('branch.baseBadge')}</span>}
                {data.mode === 'remote' && b.local && !b.remote && (
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300" title={t('branch.notPublishedTitle')}>{t('branch.notPublished')}</span>
                )}
              </button>
            ))}
          </div>

          {data.dirty_files > 0 && !blocked && (
            <p className="px-3 pt-1.5 text-[11px] text-gray-500 dark:text-gray-400">{t('branch.pendingKept', { branch: data.current })}</p>
          )}

          <div className="my-1.5 border-t border-gray-200 dark:border-white/8" />

          {creating ? (
            <form
              className="px-3 py-1 flex items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); if (nameValid && !blocked) void create(); }}
            >
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value.replace(/\s+/g, '-'))}
                placeholder={t('branch.createPlaceholder')}
                aria-label={t('branch.create')}
                maxLength={200}
                className="flex-1 min-w-0 h-8 px-2 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand-500"
              />
              <button type="submit" disabled={!nameValid || blocked} className="h-8 px-3 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium disabled:opacity-50">
                {working ? t('branch.creating') : t('branch.createAction')}
              </button>
            </form>
          ) : (
            <button role="menuitem" disabled={blocked} onClick={() => setCreating(true)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 disabled:opacity-50">
              <span className="w-4 shrink-0 text-center">+</span>
              <span>{t('branch.create')}</span>
            </button>
          )}
          {creating && <p className="px-3 pt-1 text-[11px] text-gray-500 dark:text-gray-400">{t('branch.createHint', { branch: data.current })}</p>}

          {!onBase && (
            confirmMerge ? (
              <div className="mx-3 my-1.5 rounded-lg border border-gray-200 dark:border-white/10 p-2.5">
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  {data.mode === 'remote'
                    ? t('branch.mergeConfirmRemote', { branch: data.current, base: data.base })
                    : t('branch.mergeConfirmLocal', { branch: data.current, base: data.base })}
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button onClick={() => setConfirmMerge(false)} className="h-7 px-2.5 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/8">{t('common.cancel')}</button>
                  <button disabled={blocked} onClick={() => void merge()} className="h-7 px-2.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium disabled:opacity-50">
                    {working ? t('branch.merging') : t('branch.mergeAction')}
                  </button>
                </div>
              </div>
            ) : (
              <button role="menuitem" disabled={blocked} onClick={() => setConfirmMerge(true)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 disabled:opacity-50">
                <span className="w-4 shrink-0 text-center">⤵</span>
                <span className="truncate">{t('branch.merge', { branch: data.current, base: data.base })}</span>
              </button>
            )
          )}

          {data.mode === 'local' && (
            <p className="px-3 pt-1.5 pb-0.5 text-[11px] text-gray-400 dark:text-gray-500">{t('branch.localOnly')}</p>
          )}
        </div>
      )}
    </div>
  );
}
