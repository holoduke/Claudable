"use client";
/**
 * Superadmin-only block on the project's Access tab: which organisation the
 * project belongs to, with a select to move it. Renders nothing for everyone
 * else (the API refuses non-superadmins anyway).
 */
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface OrgOption { id: string; name: string; type: 'intern' | 'klant' | string }

export default function ProjectOrganisationSettings({ projectId }: { projectId: string }) {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [options, setOptions] = useState<OrgOption[] | null>(null); // null = not superadmin / not loaded
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/organization`);
      if (!res.ok) { setOptions(null); return; } // 403 for non-superadmins → hide the block
      const json = await res.json();
      if (json?.success) { setOrgId(json.data.orgId ?? null); setOptions(json.data.options as OrgOption[]); }
    } catch { setOptions(null); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  if (!options) return null;

  const move = async (next: string) => {
    if (!next || next === orgId) return;
    const target = options.find((o) => o.id === next);
    if (!window.confirm(`Project verplaatsen naar ${target?.name ?? next}? Alleen leden van die organisatie zien het daarna nog; toewijzingen van anderen vervallen.`)) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/organization`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Verplaatsen mislukt');
      setOrgId(next);
      setMsg({ text: `Verplaatst naar ${target?.name ?? next}`, kind: 'ok' });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Verplaatsen mislukt', kind: 'err' });
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/8 p-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="font-medium text-gray-900 dark:text-gray-50">Organisatie</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Het project hoort bij precies één organisatie; alleen haar leden (en superadmins) zien het.
          {msg && <span className={`ml-2 ${msg.kind === 'ok' ? 'text-green-700 dark:text-green-300' : 'text-red-600'}`}>{msg.text}</span>}
        </p>
      </div>
      <select
        value={orgId ?? ''}
        disabled={busy}
        onChange={(e) => move(e.target.value)}
        className="shrink-0 pl-3 pr-8 py-2 text-sm border border-gray-200 dark:border-white/8 rounded-lg bg-white dark:bg-white/6 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 disabled:opacity-50 cursor-pointer"
      >
        {orgId === null && <option value="">— geen organisatie —</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}{o.type === 'klant' ? ' (klant)' : ''}</option>
        ))}
      </select>
    </div>
  );
}
