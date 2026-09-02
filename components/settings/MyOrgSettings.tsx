"use client";
/**
 * "Organisatie"-tab voor eigenaren en beheerders van een organisatie: de leden
 * van de EIGEN organisatie(s) bekijken, toevoegen (op e-mailadres, elk domein),
 * van rol veranderen en verwijderen. Geen organisaties aanmaken/verwijderen —
 * dat blijft superadmin-werk (OrgsSettings).
 *
 * Rolregels (server-side afgedwongen in org-access.ts, hier alleen gespiegeld
 * in de UI): een beheerder kan geen eigenaren aanmaken of aanraken; de laatste
 * eigenaar kan nooit weg.
 */
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export interface MyOrg {
  id: string;
  name: string;
  type: 'intern' | 'klant';
  domain: string | null;
  role: 'eigenaar' | 'beheerder' | 'lid';
  memberCount: number;
  projectCount: number;
}

interface OrgMemberRow {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: 'eigenaar' | 'beheerder' | 'lid';
  isActive: boolean;
}

interface Props {
  orgs: MyOrg[];
  currentUserId: string;
  onToast: (message: string, type: 'success' | 'error') => void;
}

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/6 text-sm text-gray-800 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-gray-200';
const pillSelectCls =
  'px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/6 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 disabled:opacity-50 cursor-pointer';

const ROLE_LABEL: Record<OrgMemberRow['role'], string> = { eigenaar: 'Eigenaar', beheerder: 'Beheerder', lid: 'Lid' };

function OrgPanel({ org, currentUserId, onToast }: { org: MyOrg; currentUserId: string; onToast: Props['onToast'] }) {
  const [members, setMembers] = useState<OrgMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'beheerder' | 'lid'>('lid');

  const canManage = org.role === 'eigenaar' || org.role === 'beheerder';
  const isOwner = org.role === 'eigenaar';
  const ownerCount = members.filter((m) => m.role === 'eigenaar').length;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${org.id}/members`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Leden laden mislukt');
      setMembers(json.data as OrgMemberRow[]);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Leden laden mislukt', 'error');
    } finally {
      setLoading(false);
    }
  }, [org.id, onToast]);

  useEffect(() => { load(); }, [load]);

  const call = async (url: string, init: RequestInit, okMessage: string | null) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}${url}`, { headers: { 'Content-Type': 'application/json' }, ...init });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Actie mislukt');
      if (okMessage) onToast(okMessage, 'success');
      await load();
      return true;
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Actie mislukt', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addMember = async () => {
    const ok = await call(`/api/orgs/${org.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }, `${email.trim()} toegevoegd aan ${org.name}`);
    if (ok) { setEmail(''); setRole('lid'); }
  };

  const changeRole = (m: OrgMemberRow, next: string) =>
    call(`/api/orgs/${org.id}/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ role: next }) }, null);

  const remove = (m: OrgMemberRow) => {
    const self = m.userId === currentUserId;
    if (!window.confirm(self
      ? `Jezelf uit ${org.name} verwijderen? Je verliest de toegang tot de projecten van deze organisatie.`
      : `${m.name || m.email} uit ${org.name} verwijderen?`)) return;
    return call(`/api/orgs/${org.id}/members/${m.userId}`, { method: 'DELETE' }, `${m.email} uit ${org.name} gehaald`);
  };

  /** Mag de ingelogde gebruiker deze rij aanpassen? Spiegelt canActorSetRole. */
  const rowLocked = (m: OrgMemberRow) => {
    if (!canManage) return true;
    if (!isOwner && m.role === 'eigenaar') return true; // beheerder raakt geen eigenaar aan
    if (m.role === 'eigenaar' && ownerCount <= 1) return true; // laatste eigenaar
    return false;
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/8 overflow-hidden">
      <div className="flex items-center gap-3 p-4 bg-gray-50 dark:bg-white/3">
        <div className="w-9 h-9 rounded-lg bg-gray-200 dark:bg-white/6 flex items-center justify-center text-sm font-semibold text-gray-600 dark:text-gray-300 shrink-0">
          {org.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{org.name}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {org.memberCount} {org.memberCount === 1 ? 'lid' : 'leden'} · {org.projectCount} {org.projectCount === 1 ? 'project' : 'projecten'}
            {org.domain ? ` · ${org.domain}` : ''}
          </p>
        </div>
        <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300 bg-gray-200 dark:bg-white/8 px-2 py-0.5 rounded-full">
          jij: {ROLE_LABEL[org.role]}
        </span>
      </div>

      <div className="p-4 space-y-3">
        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Leden laden…</p>
        ) : (
          <ul className="space-y-2">
            {members.map((m) => {
              const locked = rowLocked(m);
              return (
                <li key={m.userId} className="flex items-center gap-3">
                  {m.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.image} alt="" className="w-7 h-7 rounded-full" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-white/6 flex items-center justify-center text-xs font-medium text-gray-600 dark:text-gray-300">
                      {(m.name || m.email).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 dark:text-gray-100 truncate">
                      {m.name || m.email}
                      {m.userId === currentUserId && <span className="ml-2 text-[11px] text-gray-500 dark:text-gray-400">(jij)</span>}
                      {!m.isActive && <span className="ml-2 text-[11px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-sm">gedeactiveerd</span>}
                    </p>
                    {m.name && <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{m.email}</p>}
                  </div>
                  {canManage ? (
                    <>
                      <select value={m.role} disabled={busy || locked}
                        title={locked ? (m.role === 'eigenaar' && ownerCount <= 1 ? 'Laatste eigenaar — wijs eerst een andere eigenaar aan' : 'Alleen een eigenaar kan eigenaren wijzigen') : undefined}
                        onChange={(e) => changeRole(m, e.target.value)} className={pillSelectCls}>
                        {isOwner && <option value="eigenaar">Eigenaar</option>}
                        {!isOwner && m.role === 'eigenaar' && <option value="eigenaar">Eigenaar</option>}
                        <option value="beheerder">Beheerder</option>
                        <option value="lid">Lid</option>
                      </select>
                      <button onClick={() => remove(m)} disabled={busy || locked}
                        className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-white/3 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
                        Verwijderen
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-gray-500 dark:text-gray-400">{ROLE_LABEL[m.role]}</span>
                  )}
                </li>
              );
            })}
            {members.length === 0 && <li className="text-sm text-gray-500 dark:text-gray-400">Nog geen leden.</li>}
          </ul>
        )}

        {canManage && (
          <div className="pt-2">
            <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">Lid toevoegen</p>
            <div className="flex gap-2">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addMember(); }}
                placeholder="persoon@bedrijf.nl" className={`${inputCls} flex-1`} />
              <select value={role} onChange={(e) => setRole(e.target.value as 'beheerder' | 'lid')} className={inputCls + ' w-36'}>
                <option value="lid">Lid</option>
                <option value="beheerder">Beheerder</option>
              </select>
              <button onClick={addMember} disabled={busy || !email.trim()}
                className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
                Toevoegen
              </button>
            </div>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2">
              Iedereen met dit e-mailadres kan daarna via Google inloggen en ziet alleen de projecten van {org.name}.
              {isOwner ? ' Een extra eigenaar wijs je aan via het rol-menu bij een bestaand lid.' : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MyOrgSettings({ orgs, currentUserId, onToast }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">Organisatie</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          De leden van je organisatie. Eigenaren en beheerders kunnen leden toevoegen, van rol
          veranderen en verwijderen; leden zien alleen wie er meedoet.
        </p>
      </div>
      {orgs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Je bent nog geen lid van een organisatie.</p>
      ) : (
        orgs.map((org) => <OrgPanel key={org.id} org={org} currentUserId={currentUserId} onToast={onToast} />)
      )}
    </div>
  );
}
