"use client";
import { useState } from 'react';
import { apiErrorMessage } from '@/lib/client/api-error';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface LinkResult {
  owner: string;
  repo: string;
  repoUrl: string;
  defaultBranch: string;
  via: 'github-app' | 'token';
  warning: string | null;
}

/**
 * Superadmin-only: link this project to a repository that already exists on
 * github.com (publishing then goes there, via the GitHub App when installed).
 */
export default function GithubRepoLinkPanel({ projectId, onLinked }: { projectId: string; onLinked: () => void }) {
  const t = useT();
  const [repo, setRepo] = useState('');
  const [prOnly, setPrOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LinkResult | null>(null);
  const [error, setError] = useState('');

  const link = async (force = false) => {
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/github/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: repo.trim(), push_mode: prOnly ? 'pr' : 'direct', ...(force ? { force: true } : {}) }),
      });
      const j = await r.json().catch(() => null);
      if (r.status === 409 && !force) {
        if (window.confirm(apiErrorMessage(j, t('settings.githubLink.failed')))) {
          setBusy(false);
          await link(true);
        }
        return;
      }
      if (!r.ok) {
        setError(apiErrorMessage(j, t('settings.githubLink.failed')));
        return;
      }
      setResult((j?.data ?? j) as LinkResult);
      setRepo('');
      onLinked();
    } catch {
      setError(t('settings.githubLink.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 rounded-xl border border-dashed border-gray-300 dark:border-white/10 p-4">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('settings.githubLink.title')}</h4>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-3">{t('settings.githubLink.description')}</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="new-story/storyloop"
          aria-label={t('settings.githubLink.repo')}
          className="flex-1 text-sm font-mono px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3"
        />
        <button type="button" onClick={() => link()} disabled={busy || !repo.trim()}
          className="px-4 py-2 text-sm rounded-lg bg-brand-500 text-white disabled:opacity-50 whitespace-nowrap">
          {busy ? t('settings.githubLink.linking') : t('settings.githubLink.link')}
        </button>
      </div>
      <label className="flex items-center gap-2 mt-2 text-xs text-gray-600 dark:text-gray-300">
        <input type="checkbox" checked={prOnly} onChange={(e) => setPrOnly(e.target.checked)} />
        {t('settings.githubLink.prOnly')}
      </label>
      {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
      {result && (
        <div role="status" className="text-xs mt-2 space-y-1">
          <p className="text-emerald-600">
            {t('settings.githubLink.linked', {
              repo: `${result.owner}/${result.repo}`,
              via: t(result.via === 'github-app' ? 'settings.githubLink.viaApp' : 'settings.githubLink.viaToken'),
            })}
          </p>
          {result.warning && <p className="text-amber-700 dark:text-amber-300">{result.warning}</p>}
        </div>
      )}
    </div>
  );
}
