/**
 * Environment Settings Component
 * Manage environment variables
 */
import React, { useState, useEffect, useCallback } from 'react';
import { responseErrorMessage } from '@/lib/client/api-error';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface EnvironmentVariable {
  key: string;
  value: string;
  isSecret?: boolean;
  /** 'file' = only in the project's .env (written by the agent/import), not yet managed here. */
  source?: 'db' | 'file';
}

interface EnvironmentSettingsProps {
  projectId: string;
}

/** Read the API's human error text; fall back to the status code. */
function errText(response: Response): Promise<string> {
  return responseErrorMessage(response);
}

export function EnvironmentSettings({ projectId }: EnvironmentSettingsProps) {
  const t = useT();
  const [variables, setVariables] = useState<EnvironmentVariable[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [isSecret, setIsSecret] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // Edits live in local state so Cancel can't leave never-saved values on screen.
  const [editValue, setEditValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  const loadEnvironmentVariables = useCallback(async () => {
    setIsLoading(true);
    setLoadError('');
    try {
      const response = await fetch(`${API_BASE}/api/env/${projectId}`);
      if (!response.ok) {
        setLoadError(await errText(response));
        setVariables([]);
        return;
      }
      const data = await response.json();
      // API rows use snake_case (is_secret) — map to the UI shape so secrets
      // stay masked after a reload.
      const rows = Array.isArray(data) ? data : [];
      setVariables(rows.map((r: { key: string; value: string; is_secret?: boolean; isSecret?: boolean; source?: string }) => ({
        key: r.key,
        value: r.value,
        isSecret: Boolean(r.is_secret ?? r.isSecret),
        source: r.source === 'file' ? 'file' : 'db',
      })));
    } catch (err) {
      console.error('Failed to load environment variables:', err);
      setLoadError(t('settings.env.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    loadEnvironmentVariables();
  }, [loadEnvironmentVariables]);

  const handleAdd = async () => {
    if (!newKey || !newValue || isBusy) return;
    setIsBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/api/env/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: newKey,
          value: newValue,
          scope: 'runtime',
          var_type: 'string',
          is_secret: isSecret
        })
      });

      if (!response.ok) {
        setError(await errText(response));
        return;
      }
      // A key that already existed only in .env is now managed here — replace its row.
      setVariables([
        ...variables.filter((v) => v.key !== newKey),
        { key: newKey, value: newValue, isSecret, source: 'db' },
      ]);
      setNewKey('');
      setNewValue('');
      setIsSecret(false);
    } catch (err) {
      console.error('Failed to add environment variable:', err);
      setError(t('settings.env.addNetwork'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleUpdate = async (index: number) => {
    const variable = variables[index];
    if (!variable || isBusy) return;
    setIsBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/api/env/${projectId}/${encodeURIComponent(variable.key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: editValue })
      });

      if (!response.ok) {
        setError(await errText(response));
        return;
      }
      const updated = [...variables];
      // Saving a file-only key adopts it into Project Settings.
      updated[index] = { ...variable, value: editValue, source: 'db' };
      setVariables(updated);
      setEditingIndex(null);
    } catch (err) {
      console.error('Failed to update environment variable:', err);
      setError(t('settings.env.updateNetwork'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async (index: number, key: string) => {
    if (isBusy) return;
    if (!confirm(t('settings.env.confirmDelete', { key }))) return;
    setIsBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/api/env/${projectId}/${encodeURIComponent(key)}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        setError(await errText(response));
        return;
      }
      setVariables(variables.filter((_, i) => i !== index));
    } catch (err) {
      console.error('Failed to delete environment variable:', err);
      setError(t('settings.env.deleteNetwork'));
    } finally {
      setIsBusy(false);
    }
  };

  // The intro names the .env file via a {file} slot so it can be shown as code.
  const [envIntroBefore, ...envIntroRest] = t('settings.env.intro').split('{file}');
  const envIntroAfter = envIntroRest.join('.env');

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-4">
          {t('settings.env.title')}
        </h3>

        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
          {envIntroBefore}<code className="font-mono">.env</code>{envIntroAfter}
        </p>

        {error && (
          <div className="mb-4 flex items-start justify-between gap-3 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
            <span className="wrap-break-word min-w-0">{error}</span>
            <button onClick={() => setError('')} aria-label={t('settings.env.dismiss')} className="shrink-0 hover:text-red-800 dark:hover:text-red-300">✕</button>
          </div>
        )}

        {/* Variables List */}
        <div className="space-y-2 mb-6">
          {isLoading ? (
            <div className="text-gray-500 dark:text-gray-400">{t('settings.env.loading')}</div>
          ) : loadError ? (
            <div className="text-sm text-red-600 dark:text-red-400">
              {loadError}{' '}
              <button onClick={loadEnvironmentVariables} className="underline hover:no-underline">{t('settings.env.retry')}</button>
            </div>
          ) : variables.length === 0 ? (
            <div className="text-gray-500 dark:text-gray-400 text-sm">{t('settings.env.empty')}</div>
          ) : (
            variables.map((variable, index) => (
              <div
                key={variable.key}
                className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-white/3 rounded-lg"
              >
                {editingIndex === index ? (
                  <>
                    {/* The key identifies the row server-side — rename isn't supported, so it's read-only here. */}
                    <span className="flex-1 px-2 py-1 font-mono text-sm text-gray-500 dark:text-gray-400">
                      {variable.key}
                    </span>
                    <input
                      type={variable.isSecret ? 'password' : 'text'}
                      value={editValue}
                      aria-label={t('settings.env.valueFor', { key: variable.key })}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="flex-1 px-2 py-1 border border-gray-300 dark:border-white/8 rounded-sm "
                    />
                    <button
                      onClick={() => handleUpdate(index)}
                      disabled={isBusy}
                      className="px-3 py-1 text-sm bg-green-500 text-white rounded-sm hover:bg-green-600 disabled:opacity-50"
                    >
                      {t('settings.env.save')}
                    </button>
                    <button
                      onClick={() => setEditingIndex(null)}
                      disabled={isBusy}
                      className="px-3 py-1 text-sm bg-gray-400 text-white rounded-sm hover:bg-gray-500 disabled:opacity-50"
                    >
                      {t('settings.env.cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="font-mono text-sm text-gray-700 dark:text-gray-200 ">
                      {variable.key}
                    </span>
                    <span className="text-gray-400 dark:text-gray-500">=</span>
                    <span className="flex-1 font-mono text-sm text-gray-600 dark:text-gray-300 ">
                      {variable.isSecret ? '••••••••' : variable.value}
                    </span>
                    {variable.source === 'file' && (
                      <span
                        className="text-xs px-2 py-1 bg-gray-200 dark:bg-white/8 text-gray-600 dark:text-gray-300 rounded-sm whitespace-nowrap"
                        title={t('settings.env.fromEnvTitle')}
                      >
                        {t('settings.env.fromEnv')}
                      </span>
                    )}
                    {variable.isSecret && (
                      <span className="text-xs px-2 py-1 bg-yellow-100 text-yellow-700 rounded-sm">
                        {t('settings.env.secret')}
                      </span>
                    )}
                    <button
                      onClick={() => { setEditingIndex(index); setEditValue(variable.value); }}
                      aria-label={t('settings.env.edit', { key: variable.key })}
                      className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 "
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(index, variable.key)}
                      aria-label={t('settings.env.delete', { key: variable.key })}
                      disabled={isBusy}
                      className="p-1 text-red-400 hover:text-red-600 disabled:opacity-50"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        {/* Add New Variable */}
        <div className="border-t border-gray-200 dark:border-white/8 pt-6">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">
            {t('settings.env.addTitle')}
          </h4>
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={t('settings.env.phKey')}
                aria-label={t('settings.env.phKey')}
                value={newKey}
                onChange={(e) => {
                  const value = e.target.value;
                  // Only allow letters, numbers, and underscores, convert to uppercase
                  const cleaned = value
                    .replace(/[^a-zA-Z0-9_]/g, '') // Remove invalid characters instead of replacing with _
                    .toUpperCase();
                  setNewKey(cleaned);
                }}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-white/8 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-brand-500 "
              />
              <input
                type={isSecret ? 'password' : 'text'}
                placeholder={t('settings.env.phValue')}
                aria-label={t('settings.env.phValue')}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-white/8 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-brand-500 "
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isSecret}
                  onChange={(e) => setIsSecret(e.target.checked)}
                  className="w-4 h-4 text-brand-500 border-gray-300 dark:border-white/8 rounded-sm focus:ring-brand-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-200 ">
                  {t('settings.env.markSecret')}
                </span>
              </label>

              <button
                onClick={handleAdd}
                disabled={!newKey || !newValue || isBusy}
                className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isBusy ? t('settings.env.working') : t('settings.env.addVariable')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
