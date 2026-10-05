"use client";
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage } from '@/lib/client/api-error';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Option {
  id: string;
  label: string;
  ownerName: string | null;
  ownerEmail: string;
  isMine: boolean;
}

interface Props {
  projectId: string;
}

export default function ProjectClaudeSettings({ projectId }: Props) {
  const t = useT();
  const [options, setOptions] = useState<Option[]>([]);
  // The assigned credential when it is NOT selectable by the viewer (someone
  // else's private account) — shown read-only so the real assignment is visible.
  const [current, setCurrent] = useState<Option | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/claude-credential`);
      const json = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        setDenied(apiErrorMessage(json, t('settings.projectClaude.denied')));
        return;
      }
      if (json.success) {
        setOptions(json.data.options as Option[]);
        setCurrent((json.data.current as Option | null) ?? null);
        setCredentialId(json.data.credentialId ?? null);
        setDenied(null);
      } else {
        setLoadError(apiErrorMessage(json, t('settings.projectClaude.loadFailed')));
      }
    } catch {
      setLoadError(t('settings.projectClaude.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => { load(); }, [load]);

  const choose = async (value: string) => {
    const credId = value === '__default__' ? null : value;
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/claude-credential`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId: credId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(json, t('settings.projectClaude.saveFailed')));
      setCredentialId(credId);
      // Switching away from a non-selectable (private) assignment: it no longer
      // applies — clearing it stops the "currently runs on X (private)" note
      // from asserting stale misinformation until a reload.
      setCurrent(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t('settings.projectClaude.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</div>;
  if (denied) {
    return (
      <div className="p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-1">{t('settings.projectClaude.title')}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">{denied}</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <h3 id="settings-project-claude-title" className="text-lg font-medium text-gray-900 dark:text-gray-50">{t('settings.projectClaude.title')}</h3>

      {loadError && <p role="alert" className="text-xs text-red-500">{loadError}</p>}

      <select
        aria-labelledby="settings-project-claude-title"
        value={credentialId ?? '__default__'}
        onChange={(e) => choose(e.target.value)}
        disabled={busy}
        className="w-full max-w-md px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/6 text-sm text-gray-800 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-gray-200 disabled:opacity-50"
      >
        <option value="__default__">{t('settings.projectClaude.default')}</option>
        {current && (
          <option key={current.id} value={current.id} disabled>
            {current.label} — {current.ownerName || current.ownerEmail} {t('settings.projectClaude.private')}
          </option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label} — {o.isMine ? t('settings.projectClaude.you') : (o.ownerName || o.ownerEmail)}
          </option>
        ))}
      </select>

      {saveError && (
        <p role="alert" className="text-xs text-red-500">{saveError}</p>
      )}

      {current && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('settings.projectClaude.privateNote', { label: current.label, owner: current.ownerName || current.ownerEmail })}
        </p>
      )}

      {options.length === 0 && (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {t('settings.projectClaude.empty')}
        </p>
      )}

    </div>
  );
}
