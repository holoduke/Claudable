"use client";
/**
 * Organisatiebeheer (superadmin-tab in Global Settings): organisaties
 * aanmaken/bewerken/verwijderen en per organisatie de leden en hun rollen
 * beheren. De tenant-laag voor het klantportaal.
 */
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Org {
  id: string;
  name: string;
  type: 'intern' | 'klant';
  domain: string | null;
  canCreateProjects: boolean;
  claudeCredential: { label: string; since: string } | null;
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

interface InviteRow {
  id: string;
  email: string;
  role: 'eigenaar' | 'beheerder' | 'lid';
  invitedBy: string | null;
  expiresAt: string;
  status: 'open' | 'verlopen' | 'ingetrokken';
}

interface OrgsSettingsProps {
  onToast: (message: string, type: 'success' | 'error') => void;
}

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/6 text-sm text-gray-800 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-gray-200';
const pillSelectCls =
  'px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/6 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 disabled:opacity-50 cursor-pointer';

function TypeBadge({ type }: { type: Org['type'] }) {
  return type === 'klant' ? (
    <span className="text-[11px] font-medium text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-500/20 px-1.5 py-0.5 rounded-sm">klant</span>
  ) : (
    <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-white/8 px-1.5 py-0.5 rounded-sm">intern</span>
  );
}

export default function OrgsSettings({ onToast }: OrgsSettingsProps) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Nieuwe organisatie
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'intern' | 'klant'>('klant');
  const [newDomain, setNewDomain] = useState('');

  // Uitgeklapte organisatie (bewerken + leden)
  const [openId, setOpenId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<'intern' | 'klant'>('klant');
  const [editDomain, setEditDomain] = useState('');
  const [members, setMembers] = useState<OrgMemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'eigenaar' | 'beheerder' | 'lid'>('lid');
  // Org-level Claude credential form
  const [credLabel, setCredLabel] = useState('');
  const [credToken, setCredToken] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Organisaties laden mislukt');
      setOrgs(json.data as Org[]);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Organisaties laden mislukt', 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => { load(); }, [load]);

  const loadMembers = useCallback(async (orgId: string) => {
    setMembersLoading(true);
    try {
      const [res, iRes] = await Promise.all([
        fetch(`${API_BASE}/api/orgs/${orgId}/members`),
        fetch(`${API_BASE}/api/orgs/${orgId}/invites`),
      ]);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Leden laden mislukt');
      setMembers(json.data as OrgMemberRow[]);
      const iJson = await iRes.json().catch(() => null);
      setInvites(iRes.ok && iJson?.success ? (iJson.data as InviteRow[]) : []);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Leden laden mislukt', 'error');
    } finally {
      setMembersLoading(false);
    }
  }, [onToast]);

  const openOrg = (org: Org) => {
    if (openId === org.id) { setOpenId(null); return; }
    setOpenId(org.id);
    setEditName(org.name);
    setEditType(org.type);
    setEditDomain(org.domain ?? '');
    setMembers([]);
    setMemberEmail('');
    setMemberRole('lid');
    loadMembers(org.id);
  };

  /** Gedeeld request-patroon: fout → toast, succes → herladen. */
  const call = async (
    url: string,
    init: RequestInit,
    okMessage: string | null,
    after?: () => Promise<unknown> | void,
  ) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}${url}`, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Actie mislukt');
      if (okMessage) onToast(okMessage, 'success');
      await after?.();
      await load();
      return true;
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Actie mislukt', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createOrg = async () => {
    const ok = await call('/api/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: newName, type: newType, domain: newDomain || undefined }),
    }, `Organisatie "${newName.trim()}" aangemaakt`);
    if (ok) { setNewName(''); setNewDomain(''); setNewType('klant'); }
  };

  const saveOrg = async (orgId: string) =>
    call(`/api/orgs/${orgId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: editName, type: editType, domain: editDomain.trim() || null }),
    }, 'Organisatie opgeslagen');

  const toggleCreate = (org: Org) =>
    call(`/api/orgs/${org.id}`, { method: 'PATCH', body: JSON.stringify({ canCreateProjects: !org.canCreateProjects }) },
      !org.canCreateProjects ? `${org.name} mag nu nieuwe projecten aanmaken` : `${org.name} kan geen nieuwe projecten meer aanmaken`);

  const setCredential = async (org: Org) => {
    const ok = await call(`/api/orgs/${org.id}/claude-credential`, {
      method: 'PUT',
      body: JSON.stringify({ label: credLabel, token: credToken }),
    }, `Claude-token voor ${org.name} opgeslagen`);
    if (ok) { setCredLabel(''); setCredToken(''); }
  };

  const removeCredential = (org: Org) => {
    if (!window.confirm(`Claude-token van ${org.name} verwijderen? Projecten vallen terug op het platform-token.`)) return;
    return call(`/api/orgs/${org.id}/claude-credential`, { method: 'DELETE' }, `Claude-token van ${org.name} verwijderd`);
  };

  const removeOrg = async (org: Org) => {
    if (!window.confirm(`Organisatie "${org.name}" verwijderen?`)) return;
    const ok = await call(`/api/orgs/${org.id}`, { method: 'DELETE' }, `"${org.name}" verwijderd`);
    if (ok) setOpenId(null);
  };

  const addMember = async (orgId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${orgId}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: memberEmail, role: memberRole }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Actie mislukt');
      onToast(json.data?.invited
        ? (json.data?.emailSent
            ? `Uitnodiging gemaild naar ${memberEmail.trim()} — 14 dagen geldig`
            : `${memberEmail.trim()} uitgenodigd (14 dagen geldig) — geen e-mail verstuurd (mail niet geconfigureerd)`)
        : `${memberEmail.trim()} toegevoegd`, 'success');
      setMemberEmail(''); setMemberRole('lid');
      await loadMembers(orgId);
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Actie mislukt', 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeMemberRole = (orgId: string, userId: string, role: string) =>
    call(`/api/orgs/${orgId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }, null, () => loadMembers(orgId));

  const revokeInvite = (orgId: string, i: InviteRow) =>
    call(`/api/orgs/${orgId}/invites/${i.id}`, { method: 'DELETE' },
      `Uitnodiging voor ${i.email} ingetrokken`, () => loadMembers(orgId));

  const removeMember = (orgId: string, m: OrgMemberRow) =>
    call(`/api/orgs/${orgId}/members/${m.userId}`, { method: 'DELETE' },
      `${m.email} uit de organisatie gehaald`, () => loadMembers(orgId));

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">Organisaties</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Elke site hoort bij precies één organisatie. Klant-organisaties krijgen straks de
          versimpelde klantweergave; leden beheer je hier per organisatie.
        </p>
      </div>

      {/* Nieuwe organisatie */}
      <div className="flex flex-col gap-3 p-4 bg-gray-50 dark:bg-white/3 rounded-xl border border-gray-200 dark:border-white/8 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Naam</label>
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') createOrg(); }}
            placeholder="Micros BV" className={inputCls} />
        </div>
        <div className="w-32">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Type</label>
          <select value={newType} onChange={(e) => setNewType(e.target.value as 'intern' | 'klant')} className={inputCls}>
            <option value="klant">Klant</option>
            <option value="intern">Intern</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Domein (optioneel)</label>
          <input type="text" value={newDomain} onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') createOrg(); }}
            placeholder="klant.nl" className={inputCls} />
        </div>
        <button onClick={createOrg} disabled={busy || !newName.trim()}
          className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
          Aanmaken
        </button>
      </div>

      {/* Organisatielijst */}
      <div className="rounded-xl border border-gray-200 dark:border-white/8 overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">Organisaties laden…</div>
        ) : orgs.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">Nog geen organisaties.</div>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-white/8">
            {orgs.map((org) => (
              <li key={org.id}>
                <button onClick={() => openOrg(org)}
                  className="w-full flex items-center gap-3 p-4 text-left hover:bg-gray-50 dark:hover:bg-white/3 transition-colors">
                  <div className="w-9 h-9 rounded-lg bg-gray-200 dark:bg-white/6 flex items-center justify-center text-sm font-semibold text-gray-600 dark:text-gray-300 shrink-0">
                    {org.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{org.name}</p>
                      <TypeBadge type={org.type} />
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {org.memberCount} {org.memberCount === 1 ? 'lid' : 'leden'} · {org.projectCount} {org.projectCount === 1 ? 'project' : 'projecten'}
                      {org.domain ? ` · ${org.domain}` : ''}
                      {!org.canCreateProjects ? ' · geen nieuwe projecten' : ''}
                      {org.claudeCredential ? ' · eigen Claude-token' : ''}
                    </p>
                  </div>
                  <span className="text-gray-400 text-xs">{openId === org.id ? '▲' : '▼'}</span>
                </button>

                {openId === org.id && (
                  <div className="px-4 pb-4 space-y-4 bg-gray-50/50 dark:bg-white/2">
                    {/* Bewerken */}
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end pt-3">
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Naam</label>
                        <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className={inputCls} />
                      </div>
                      <div className="w-32">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Type</label>
                        <select value={editType} onChange={(e) => setEditType(e.target.value as 'intern' | 'klant')} className={inputCls}>
                          <option value="klant">Klant</option>
                          <option value="intern">Intern</option>
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Domein</label>
                        <input type="text" value={editDomain} onChange={(e) => setEditDomain(e.target.value)} placeholder="—" className={inputCls} />
                      </div>
                      <button onClick={() => saveOrg(org.id)} disabled={busy || !editName.trim()}
                        className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
                        Opslaan
                      </button>
                      <button onClick={() => removeOrg(org)} disabled={busy || org.projectCount > 0 || org.memberCount > 0}
                        title={org.projectCount > 0 || org.memberCount > 0 ? 'Alleen een lege organisatie kan verwijderd worden' : 'Organisatie verwijderen'}
                        className="px-3 py-2 text-sm font-medium border border-red-200 rounded-lg bg-white dark:bg-white/3 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
                        Verwijderen
                      </button>
                    </div>

                    {/* Organisatie-instellingen (superadmin) */}
                    <div className="rounded-xl border border-gray-200 dark:border-white/8 divide-y divide-gray-200 dark:divide-white/8 bg-white dark:bg-white/3">
                      <div className="flex items-center justify-between gap-4 px-4 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-50">Nieuwe projecten aanmaken</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Mogen leden van {org.name} zelf nieuwe projecten starten? Superadmins kunnen dat altijd.</p>
                        </div>
                        <button type="button" role="switch" aria-checked={org.canCreateProjects} disabled={busy}
                          onClick={() => toggleCreate(org)}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${org.canCreateProjects ? 'bg-brand-500' : 'bg-gray-300 dark:bg-white/15'}`}
                          title={org.canCreateProjects ? 'Aanmaken uitschakelen' : 'Aanmaken toestaan'}>
                          <span className={`inline-block h-5 w-5 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${org.canCreateProjects ? 'translate-x-5' : 'translate-x-1'}`} />
                        </button>
                      </div>
                      <div className="px-4 py-3 space-y-2">
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-50">Claude-token van de organisatie</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              Hierop draait de agent (<code>claude -p</code>) voor projecten van {org.name} als project of gebruiker geen eigen token heeft.
                              Een OAuth-token uit <code>claude setup-token</code> of een API-sleutel (sk-ant-api…).
                            </p>
                          </div>
                          {org.claudeCredential ? (
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[11px] font-medium text-green-700 dark:text-green-300 bg-green-100 dark:bg-green-500/20 px-2 py-0.5 rounded-full">
                                {org.claudeCredential.label} · sinds {new Date(org.claudeCredential.since).toLocaleDateString('nl-NL')}
                              </span>
                              <button onClick={() => removeCredential(org)} disabled={busy}
                                className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-white/3 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
                                Verwijderen
                              </button>
                            </div>
                          ) : (
                            <span className="shrink-0 text-[11px] font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-white/8 px-2 py-0.5 rounded-full">platform-token</span>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <input type="text" value={credLabel} onChange={(e) => setCredLabel(e.target.value)} placeholder={`Label (bijv. ${org.name} Claude)`} className={`${inputCls} w-48! shrink-0`} />
                          <input type="password" value={credToken} onChange={(e) => setCredToken(e.target.value)} placeholder="sk-ant-oat… of sk-ant-api…" className={`${inputCls} flex-1 min-w-0 font-mono`} autoComplete="off" />
                          <button onClick={() => setCredential(org)} disabled={busy || !credToken.trim()}
                            className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
                            {org.claudeCredential ? 'Vervangen' : 'Instellen'}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Leden */}
                    <div>
                      <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">Leden</p>
                      {membersLoading ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">Leden laden…</p>
                      ) : (
                        <ul className="space-y-2">
                          {members.map((m) => (
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
                                  {!m.isActive && <span className="ml-2 text-[11px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-sm">gedeactiveerd</span>}
                                </p>
                                {m.name && <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{m.email}</p>}
                              </div>
                              <select value={m.role} disabled={busy}
                                onChange={(e) => changeMemberRole(org.id, m.userId, e.target.value)}
                                className={pillSelectCls}>
                                <option value="eigenaar">Eigenaar</option>
                                <option value="beheerder">Beheerder</option>
                                <option value="lid">Lid</option>
                              </select>
                              <button onClick={() => removeMember(org.id, m)} disabled={busy}
                                className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-white/3 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
                                Verwijderen
                              </button>
                            </li>
                          ))}
                          {members.length === 0 && (
                            <li className="text-sm text-gray-500 dark:text-gray-400">Nog geen leden.</li>
                          )}
                        </ul>
                      )}

                      {/* Openstaande uitnodigingen */}
                      {invites.filter((i) => i.status === 'open').length > 0 && (
                        <div className="mt-3">
                          <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">Openstaande uitnodigingen</p>
                          <ul className="space-y-2">
                            {invites.filter((i) => i.status === 'open').map((i) => (
                              <li key={i.id} className="flex items-center gap-3">
                                <div className="w-7 h-7 rounded-full border border-dashed border-gray-300 dark:border-white/15 flex items-center justify-center text-xs text-gray-500">✉</div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-gray-800 dark:text-gray-100 truncate">{i.email}</p>
                                  <p className="text-[11px] text-gray-500 dark:text-gray-400">
                                    {i.role} · verloopt {new Date(i.expiresAt).toLocaleDateString('nl-NL')}{i.invitedBy ? ` · door ${i.invitedBy}` : ''}
                                  </p>
                                </div>
                                <button onClick={() => revokeInvite(org.id, i)} disabled={busy}
                                  className="px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/3 text-gray-600 dark:text-gray-300 hover:bg-gray-50 transition-colors disabled:opacity-40">
                                  Intrekken
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Lid toevoegen */}
                      <div className="flex gap-2 mt-3">
                        <input type="email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') addMember(org.id); }}
                          placeholder="persoon@klant.nl" className={`${inputCls} flex-1 min-w-0`} />
                        <select value={memberRole} onChange={(e) => setMemberRole(e.target.value as 'eigenaar' | 'beheerder' | 'lid')} className={`${inputCls} w-36! shrink-0`}>
                          <option value="lid">Lid</option>
                          <option value="beheerder">Beheerder</option>
                          <option value="eigenaar">Eigenaar</option>
                        </select>
                        <button onClick={() => addMember(org.id)} disabled={busy || !memberEmail.trim()}
                          className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
                          Toevoegen
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
