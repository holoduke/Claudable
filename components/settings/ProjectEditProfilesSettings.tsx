"use client";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiErrorMessage } from '@/lib/client/api-error';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

type ProfileId = 'full' | 'content' | 'style' | 'content-style' | 'custom';
type Kind = 'text' | 'style' | 'asset' | 'code';

interface Profile { id: ProfileId; label: string; description: string; kinds: Kind[]; defined: boolean }
interface Person { id: string; email: string; name: string | null; image: string | null; exempt: boolean; owner: boolean }
interface CustomProfile { label: string; description: string; kinds: Kind[]; allowPaths: string[]; denyPaths: string[] }
interface Config { default: ProfileId; members: Record<string, ProfileId>; custom: CustomProfile | null }

const KIND_OPTIONS: { kind: Kind; label: string; hint: string }[] = [
  { kind: 'text', label: 'Text', hint: 'Headings, paragraphs, button labels, links, Markdown and translation files' },
  { kind: 'style', label: 'Styling', hint: 'Classes, CSS, colours and fonts in the theme config' },
  { kind: 'asset', label: 'Images & media', hint: 'Add or replace pictures, video and fonts' },
  { kind: 'code', label: 'Code & structure', hint: 'Elements, components, logic, config — everything else' },
];

const EMPTY_CUSTOM: CustomProfile = { label: 'Custom', description: '', kinds: ['text'], allowPaths: [], denyPaths: [] };

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

export default function ProjectEditProfilesSettings({ projectId }: { projectId: string }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [allowText, setAllowText] = useState('');
  const [denyText, setDenyText] = useState('');

  const apply = useCallback((data: { config?: Config; profiles?: Profile[]; people?: Person[] }) => {
    if (data.profiles) setProfiles(data.profiles);
    if (data.people) setPeople(data.people);
    if (data.config) {
      setConfig(data.config);
      setSaved(JSON.stringify(data.config));
      setAllowText((data.config.custom?.allowPaths ?? []).join('\n'));
      setDenyText((data.config.custom?.denyPaths ?? []).join('\n'));
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/edit-profiles`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(apiErrorMessage(json, 'Failed to load edit profiles'));
      setCanManage(Boolean(json.data.canManage));
      apply(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load edit profiles');
    } finally {
      setLoading(false);
    }
  }, [projectId, apply]);

  useEffect(() => { load(); }, [load]);

  const draft = useMemo<Config | null>(() => {
    if (!config) return null;
    if (!config.custom) return config;
    return { ...config, custom: { ...config.custom, allowPaths: lines(allowText), denyPaths: lines(denyText) } };
  }, [config, allowText, denyText]);
  const dirty = draft !== null && JSON.stringify(draft) !== saved;

  const labelOf = (id: ProfileId) => (id === 'custom' ? draft?.custom?.label || 'Custom' : profiles.find((p) => p.id === id)?.label ?? id);
  const selectable = profiles.filter((p) => p.id !== 'custom' || Boolean(config?.custom));

  const setDefault = (id: ProfileId) => setConfig((c) => (c ? { ...c, default: id } : c));
  const setMember = (userId: string, id: ProfileId | '') =>
    setConfig((c) => {
      if (!c) return c;
      const { [userId]: _removed, ...rest } = c.members;
      return { ...c, members: id ? { ...rest, [userId]: id } : rest };
    });
  const setCustom = (patch: Partial<CustomProfile>) =>
    setConfig((c) => (c ? { ...c, custom: { ...(c.custom ?? EMPTY_CUSTOM), ...patch } } : c));
  const toggleKind = (kind: Kind) => {
    const kinds = draft?.custom?.kinds ?? [];
    setCustom({ kinds: kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind] });
  };
  const removeCustom = () =>
    setConfig((c) => {
      if (!c) return c;
      const members = Object.fromEntries(Object.entries(c.members).filter(([, v]) => v !== 'custom'));
      return { ...c, custom: null, members, default: c.default === 'custom' ? 'content' : c.default };
    });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/edit-profiles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(apiErrorMessage(json, 'Failed to save'));
      apply(json.data);
      setNotice('Saved — applies from the next chat message.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="text-sm text-gray-500 dark:text-gray-400">Loading edit profiles…</div>;
  if (!canManage || !draft) return null;

  const selectCls = 'text-xs border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/6 text-gray-700 dark:text-gray-200 px-2 py-1 disabled:opacity-40';
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/6 text-sm text-gray-800 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-brand-500';
  const defaultProfile = profiles.find((p) => p.id === draft.default);

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-base font-medium text-gray-900 dark:text-gray-50">Edit profiles</h4>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          What the AI may change for someone in this project. The owner and admins (and New Story staff in customer
          projects) can always change everything. Edits outside a profile are blocked, and anything that slips through is undone after the turn.
        </p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && !dirty && <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-500/20 dark:bg-green-500/10 dark:text-green-300">{notice}</div>}

      <div className="flex items-start justify-between gap-4 p-4 bg-gray-50 dark:bg-white/3 rounded-xl border border-gray-200 dark:border-white/8">
        <div className="min-w-0">
          <p className="font-medium text-gray-900 dark:text-gray-50 text-sm">Default for everyone else</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {draft.default === 'custom' ? draft.custom?.description || 'Custom profile' : defaultProfile?.description}
          </p>
        </div>
        <select value={draft.default} onChange={(e) => setDefault(e.target.value as ProfileId)} disabled={busy} className={selectCls}>
          {selectable.map((p) => <option key={p.id} value={p.id}>{labelOf(p.id)}</option>)}
        </select>
      </div>

      <div>
        <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">Per person</p>
        {people.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">No other people can edit this project yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-white/6 rounded-xl border border-gray-200 dark:border-white/8">
            {people.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{p.name || p.email}</span>
                  {p.name && <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">{p.email}</span>}
                </span>
                {p.exempt ? (
                  <span className="text-xs text-gray-500 dark:text-gray-400">{p.owner ? 'Owner' : 'Admin / staff'} · always everything</span>
                ) : (
                  <select value={draft.members[p.id] ?? ''} onChange={(e) => setMember(p.id, e.target.value as ProfileId | '')} disabled={busy} className={selectCls}>
                    <option value="">Default ({labelOf(draft.default)})</option>
                    {selectable.map((pr) => <option key={pr.id} value={pr.id}>{labelOf(pr.id)}</option>)}
                  </select>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-white/8">
        <button
          type="button"
          onClick={() => { if (!draft.custom) setCustom({}); setCustomOpen((o) => !o || !draft.custom); }}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-50"
        >
          <span>{draft.custom ? `Custom profile: ${draft.custom.label}` : 'Create a custom profile'}</span>
          <span className="text-gray-400">{customOpen && draft.custom ? '−' : '+'}</span>
        </button>
        {customOpen && draft.custom && (
          <div className="px-4 pb-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Name</span>
                <input value={draft.custom.label} maxLength={60} onChange={(e) => setCustom({ label: e.target.value })} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Note for the AI (optional)</span>
                <input value={draft.custom.description} maxLength={500} placeholder="e.g. Only the blog and the team page" onChange={(e) => setCustom({ description: e.target.value })} className={inputCls} />
              </label>
            </div>
            <div>
              <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">May change</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {KIND_OPTIONS.map((o) => (
                  <label key={o.kind} className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-100">
                    <input type="checkbox" className="mt-0.5" checked={draft.custom!.kinds.includes(o.kind)} onChange={() => toggleKind(o.kind)} />
                    <span>{o.label}<span className="block text-xs text-gray-500 dark:text-gray-400">{o.hint}</span></span>
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Only these files (one pattern per line)</span>
                <textarea rows={3} value={allowText} placeholder={'content/**\npages/blog/**'} onChange={(e) => setAllowText(e.target.value)} className={`${inputCls} font-mono text-xs`} />
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Never these files</span>
                <textarea rows={3} value={denyText} placeholder={'pages/checkout.vue'} onChange={(e) => setDenyText(e.target.value)} className={`${inputCls} font-mono text-xs`} />
              </label>
            </div>
            <div className="flex justify-between items-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Empty “only these files” means all files. Patterns use * and **.</p>
              <button type="button" onClick={removeCustom} disabled={busy} className="text-xs text-red-600 hover:underline disabled:opacity-40">Remove custom profile</button>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty || (draft.custom !== null && draft.custom.kinds.length === 0)}
          className="px-4 py-2 rounded-lg bg-brand-500 text-white text-sm font-medium hover:bg-brand-600 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save edit profiles'}
        </button>
      </div>
    </div>
  );
}
